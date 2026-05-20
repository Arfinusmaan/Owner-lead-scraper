import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { nanoid } from 'nanoid';
import multer from 'multer';
import csvParser from 'csv-parser';
import stream from 'stream';

import { scrapeGoogleMaps, enrichCSVList } from './scraper.js';
import { createJob, getJob, updateJob, setStopFlag, setPauseFlag, deleteJob, loadJobsFromDisk, jobs } from './store.js';
import { log } from './utils.js';
import { scrapeUniversal, ALL_JURISDICTIONS, resolveJurisdiction } from './sosScrapers/index.js';
import { batchMatchBusinesses } from './googleMapsMatcher.js';
import { enrichOwner, closeEnricherBrowser } from './ownerEnricher.js';

const app = express();
const PORT = 3001;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(bodyParser.json());

// Initialize store from disk
loadJobsFromDisk();

// =========================
// CSV UPLOAD & ENRICHMENT
// =========================
app.post('/upload-csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const mode = req.body.mode || 'hybrid';
  const workers = req.body.workers || 3;
  const negativeKeywords = req.body.negativeKeywords || '';
  const jobId = nanoid();
  const leads = [];

  const bufferStream = new stream.PassThrough();
  bufferStream.end(req.file.buffer);

  bufferStream
    .pipe(csvParser())
    .on('data', (data) => {
       const lead = {
         business_name: data['Company Name'] || data.Company || data.Name || data.business_name || '',
         phone: data['Phone number'] || data.Phone || data.phone || '',
         website: data.website || data.Website || '',
         primary_email: data['Primary Email'] || data.primary_email || '',
         owner_name: data['Owner Name'] || data.owner_name || '',
         owner_role: data['Owner Role'] || data.owner_role || '',
         rating: data.Rating || data.rating || '',
         reviews: data.Review || data.Reviews || data.reviews || '',
         intent: data.Intent || data.intent || 'LOW',
         city: data.City || data.city || '',
       };
       leads.push(lead);
    })
    .on('end', () => {
       createJob(jobId, {
         niche: 'CSV Upload',
         location: 'Multiple',
         filterType: 'all',
         negativeKeywords,
         status: 'running',
         progress: 0,
         leads: leads,
         logs: [],
         currentCity: 'Parsing',
         createdAt: new Date(),
         stopFlag: false
       });
       
       log(`🚀 Started: CSV Enrichment for ${leads.length} leads`, jobId);
       
       enrichCSVList(leads, jobId, workers, negativeKeywords, (progressData) => {
          const job = getJob(jobId);
          if (!job || job.stopFlag) return;
          if (typeof progressData === 'number') {
            updateJob(jobId, { progress: progressData });
          } else {
            updateJob(jobId, {
              progress: progressData.progress ?? job.progress,
              currentCity: progressData.city ?? job.currentCity
            });
          }
       }).then(() => {
          const job = getJob(jobId);
          if (!job) return;
          const highIntent = job.leads.filter(l => l.intent === 'HIGH').length;
          const mediumIntent = job.leads.filter(l => l.intent === 'MEDIUM').length;
          const lowIntent = job.leads.filter(l => l.intent === 'LOW').length;
          const stats = { highIntent, mediumIntent, lowIntent, total: job.leads.length };
          updateJob(jobId, { status: job.stopFlag ? 'cancelled' : 'completed', progress: 100, stats });
       }).catch(err => {
          log(`❌ Error: ${err.message}`, jobId);
          updateJob(jobId, { status: 'failed', error: err.message });
       });

       res.json({ jobId });
    });
});

// =========================
// START SCRAPE
// =========================
app.post('/scrape', async (req, res) => {
  const { niche, location, filterType = 'all', mode = 'hybrid', workers = 3, negativeKeywords = '' } = req.body;

  const jobId = nanoid();

  createJob(jobId, {
    niche,
    location,
    filterType,
    negativeKeywords,
    status: 'running',
    progress: 0,
    leads: [],
    logs: [],
    currentCity: '',
    createdAt: new Date(),
    stopFlag: false
  });

  log(`🚀 Started: ${niche} in ${location}`, jobId);

  // ASYNC WORKER
  (async () => {
    try {
      const leads = await scrapeGoogleMaps(
        niche,
        location,
        filterType,
        negativeKeywords,
        jobId,
        mode,
        workers,
        (progressData) => {
          const job = getJob(jobId);
          if (!job || job.stopFlag) return;

          // =========================
          // PROGRESS + CITY
          // =========================
          if (typeof progressData === 'number') {
            updateJob(jobId, { progress: progressData });
          } else {
            updateJob(jobId, {
              progress: progressData.progress ?? job.progress,
              currentCity: progressData.city ?? job.currentCity
            });

            // =========================
            // 🔥 FIX: PUSH LEADS PROPERLY
            // =========================
            if (progressData.leads && Array.isArray(progressData.leads)) {
              progressData.leads.forEach(lead => {
                updateJob(jobId, { leads: [lead] });
              });
            }
          }
        }
      );

      const job = getJob(jobId);
      if (!job) return;

      // Compute stats regardless of stop state — needed for CSV download
      const highIntent   = job.leads.filter(l => l.intent === 'HIGH').length;
      const mediumIntent = job.leads.filter(l => l.intent === 'MEDIUM').length;
      const lowIntent    = job.leads.filter(l => l.intent === 'LOW').length;
      const stats = { highIntent, mediumIntent, lowIntent, total: job.leads.length };

      if (job.stopFlag) {
        // Keep status as 'cancelled' — don't overwrite what the /stop endpoint set
        log(`🛑 Cancelled with ${job.leads.length} leads collected`, jobId);
        updateJob(jobId, { stats });
        return;
      }

      updateJob(jobId, {
        status: 'completed',
        progress: 100,
        stats
      });

      log(`✅ Completed: ${job.leads.length} leads`, jobId);

    } catch (err) {
      log(`❌ Error: ${err.message}`, jobId);

      const job = getJob(jobId);
      if (job) {
        updateJob(jobId, {
          status: 'failed',
          error: err.message
        });
      }
    }
  })();

  res.json({ jobId });
});

// =========================
// RESULTS
// =========================
app.get('/results/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json(job);
});

// =========================
// CSV EXPORT
// =========================
app.get('/csv/:id', (req, res) => {
  const job = getJob(req.params.id);

  if (!job || !job.leads.length) {
    return res.status(400).json({ error: 'No data available' });
  }

  const headers = `"Company Name","Business Phone","Website","Email","Owner Name","Owner Cell","Owner Cell Source","Owner Email","Owner Email Source","Rating","Reviews","Intent","Lead Score","City","State","Address","Niche"\n`;

  const formatRow = (l) => [
    l.business_name        || '',
    l.phone                || '',
    l.website              || '',
    l.primary_email        || l.owner_email || '',
    l.owner_name           || '',
    l.owner_cell           || '',
    l.owner_cell_source    || '',
    l.owner_email          || '',
    l.owner_email_source   || '',
    l.rating               || '',
    l.reviews              || '',
    l.intent               || '',
    l.score                || '',
    l.city                 || '',
    l.state                || '',
    l.address              || '',
    job.niche              || ''
  ].map(f => `"${String(f).replace(/"/g, '""')}"`).join(',');

  // Sort: leads with owner_cell first, then owner_name, then rest
  const sorted = [...job.leads].sort((a, b) => {
    const aScore = (a.owner_cell ? 2 : 0) + (a.owner_name ? 1 : 0);
    const bScore = (b.owner_cell ? 2 : 0) + (b.owner_name ? 1 : 0);
    return bScore - aScore;
  });

  const withOwner    = sorted.filter(l => l.owner_name || l.owner_cell);
  const withoutOwner = sorted.filter(l => !l.owner_name && !l.owner_cell);

  let csvContent = '';
  if (withOwner.length)    csvContent += `"=== WITH OWNER CONTACT (${withOwner.length}) ==="\n` + headers + withOwner.map(formatRow).join('\n') + '\n\n';
  if (withoutOwner.length) csvContent += `"=== OTHER LEADS (${withoutOwner.length}) ==="\n`  + headers + withoutOwner.map(formatRow).join('\n') + '\n';
  if (!csvContent) csvContent = headers + job.leads.map(formatRow).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
  res.send(csvContent);
});

// =========================
// HISTORY
// =========================
app.get('/history', (req, res) => {
  res.json(
    Array.from(jobs.values()).map(j => ({
      id: j.id,
      niche: j.niche,
      location: j.location,
      total: j.leads.length,
      createdAt: j.createdAt,
      status: j.status,
      pinned: j.pinned || false,
      highIntent: j.stats?.highIntent || 0,
      mediumIntent: j.stats?.mediumIntent || 0,
      lowIntent: j.stats?.lowIntent || 0,
      withOwnerCell: j.leads.filter(l => l.owner_cell).length,
      withOwnerName: j.leads.filter(l => l.owner_name).length,
      sourceType: j.sourceType || 'maps',
    }))
  );
});

// =========================
// SOS SCRAPE
// =========================
app.post('/sos-scrape', async (req, res) => {
  const { state, keyword, maxLeads = 3000, enrichWithMaps = true } = req.body;

  if (!state) return res.status(400).json({ error: 'state required (FL, TN, TX)' });

  const jobId = nanoid();

  createJob(jobId, {
    niche:      keyword || `SOS:${state}`,
    location:   SOS_STATES[state.toUpperCase()]?.label || state,
    filterType: 'all',
    sourceType: 'sos',
    status:     'running',
    progress:   0,
    leads:      [],
    logs:       [],
    currentCity: 'Starting SOS pull...',
    createdAt:  new Date(),
    stopFlag:   false,
  });

  log(`🏛️ SOS Job started: ${state} | keyword: ${keyword}`, jobId);
  res.json({ jobId });

  // Async pipeline: SOS → Maps → Owner Enrichment
  (async () => {
    try {
      // ── Phase 1: SOS Pull ──
      updateJob(jobId, { currentCity: `Phase 1: SOS Pull (${state})` });
      let sosLeads = [];

      await scrapeByState(state, {
        keyword,
        maxLeads,
        onLead: (lead) => {
          if (!getJob(jobId)?.stopFlag) {
            sosLeads.push(lead);
            updateJob(jobId, { leads: [lead] });
            updateJob(jobId, { currentCity: `SOS: ${lead.business_name}` });
          }
        },
        log: (msg) => log(msg, jobId),
        getJob,
        jobId,
      });

      if (getJob(jobId)?.stopFlag) {
        updateJob(jobId, { status: 'cancelled' });
        return;
      }

      log(`✅ Phase 1 done: ${sosLeads.length} businesses from SOS`, jobId);
      updateJob(jobId, { progress: 30, currentCity: `Phase 2: Google Maps matching...` });

      // ── Phase 2: Google Maps Matching ──
      if (enrichWithMaps && sosLeads.length > 0) {
        const matched = await batchMatchBusinesses(sosLeads, {
          concurrency: 3,
          jobId,
          getJob,
          updateJob,
          log: (msg) => log(msg, jobId),
        });

        // Merge Maps data back into leads
        for (const m of matched) {
          if (!m.matched) continue;
          const idx = getJob(jobId)?.leads.findIndex(
            l => l.business_name?.toLowerCase() === m.business_name?.toLowerCase()
          );
          if (idx !== -1) {
            updateJob(jobId, {
              enrichLead: {
                business_name: m.business_name,
                phone:   m.phone   || '',
                website: m.website || '',
                rating:  m.rating  || '',
                reviews: m.reviews || '',
                address: m.address || m.address || '',
              }
            });
          }
        }

        log(`✅ Phase 2 done: Maps matched`, jobId);
      }

      updateJob(jobId, { progress: 65, currentCity: 'Phase 3: Owner enrichment...' });

      // ── Phase 3: Owner Enrichment (TPS + WHOIS) ──
      const currentLeads = getJob(jobId)?.leads || [];
      let enriched = 0;

      for (const lead of currentLeads) {
        if (getJob(jobId)?.stopFlag) break;
        if (!lead.owner_name) continue; // Skip if we have no name to look up

        const ownerData = await enrichOwner(lead, { log: (m) => log(m, jobId), jobId }).catch(() => ({}));

        if (ownerData.owner_cell || ownerData.owner_email) {
          updateJob(jobId, {
            enrichLead: {
              business_name:       lead.business_name,
              owner_cell:          ownerData.owner_cell          || '',
              owner_cell_source:   ownerData.owner_cell_source   || '',
              owner_email:         ownerData.owner_email         || '',
              owner_email_source:  ownerData.owner_email_source  || '',
              primary_email:       ownerData.owner_email         || lead.primary_email || '',
            }
          });
        }

        enriched++;
        const prog = 65 + Math.floor((enriched / currentLeads.length) * 30);
        updateJob(jobId, { progress: prog, currentCity: `Enriching: ${lead.business_name}` });
      }

      await closeEnricherBrowser().catch(() => {});

      const finalJob  = getJob(jobId);
      if (!finalJob) return;
      const stats = {
        total:           finalJob.leads.length,
        withOwnerName:   finalJob.leads.filter(l => l.owner_name).length,
        withOwnerCell:   finalJob.leads.filter(l => l.owner_cell).length,
        withEmail:       finalJob.leads.filter(l => l.primary_email || l.owner_email).length,
        withPhone:       finalJob.leads.filter(l => l.phone).length,
        highIntent:      finalJob.leads.filter(l => l.intent === 'HIGH').length,
        mediumIntent:    finalJob.leads.filter(l => l.intent === 'MEDIUM').length,
        lowIntent:       finalJob.leads.filter(l => l.intent === 'LOW').length,
      };

      updateJob(jobId, { status: 'completed', progress: 100, stats });
      log(`✅ SOS Job complete: ${finalJob.leads.length} leads | ${stats.withOwnerCell} with cell`, jobId);

    } catch (err) {
      log(`❌ SOS Error: ${err.message}`, jobId);
      updateJob(jobId, { status: 'failed', error: err.message });
      await closeEnricherBrowser().catch(() => {});
    }
  })();
});

// SOS: list all supported jurisdictions
app.get('/sos-jurisdictions', (_, res) => {
  const list = Object.entries(ALL_JURISDICTIONS).map(([name, code]) => ({
    name,
    code,
    country: code.startsWith('ca_') ? 'Canada' : 'USA',
  }));
  res.json(list);
});

// SOS SCRAPE — universal (any US state or Canadian province)
app.post('/sos-scrape', async (req, res) => {
  const { jurisdiction, keyword, maxLeads = 3000, enrichWithMaps = true } = req.body;

  if (!jurisdiction) return res.status(400).json({ error: 'jurisdiction required (e.g. "Florida", "FL", "Ontario", "ON")' });

  const jCode = resolveJurisdiction(jurisdiction);
  if (!jCode) return res.status(400).json({ error: `Unknown jurisdiction: ${jurisdiction}` });

  const stateName = Object.entries(ALL_JURISDICTIONS).find(([, v]) => v === jCode)?.[0] || jurisdiction;
  const jobId     = nanoid();

  createJob(jobId, {
    niche:       keyword || `SOS:${stateName}`,
    location:    stateName,
    filterType:  'all',
    sourceType:  'sos',
    status:      'running',
    progress:    0,
    leads:       [],
    logs:        [],
    currentCity: 'Phase 1: Pulling business registry...',
    createdAt:   new Date(),
    stopFlag:    false,
  });

  log(`🏛️ SOS started: ${stateName} | keyword: "${keyword}"`, jobId);
  res.json({ jobId });

  (async () => {
    try {
      // ── Phase 1: SOS Pull via OpenCorporates ──
      updateJob(jobId, { currentCity: `Phase 1/3 — SOS: ${stateName}` });

      await scrapeUniversal({
        jurisdiction,
        keyword,
        maxLeads,
        onLead: (lead) => {
          if (!getJob(jobId)?.stopFlag) {
            updateJob(jobId, { leads: [lead], currentCity: `SOS: ${lead.business_name}` });
          }
        },
        log: (msg) => log(msg, jobId),
        getJob,
        jobId,
      });

      if (getJob(jobId)?.stopFlag) { updateJob(jobId, { status: 'cancelled' }); return; }

      const afterSOS = getJob(jobId)?.leads?.length || 0;
      log(`✅ Phase 1 done: ${afterSOS} from SOS`, jobId);
      updateJob(jobId, { progress: 30 });

      // ── Phase 2: Google Maps matching ──
      if (enrichWithMaps) {
        updateJob(jobId, { currentCity: 'Phase 2/3 — Google Maps matching...' });
        const sosLeads = [...(getJob(jobId)?.leads || [])];

        const matched = await batchMatchBusinesses(sosLeads, {
          concurrency: 3, jobId, getJob, updateJob,
          log: (msg) => log(msg, jobId),
        });

        for (const m of matched) {
          if (!m?.matched) continue;
          updateJob(jobId, { enrichLead: {
            business_name: m.business_name,
            phone:   m.phone   || '',
            website: m.website || '',
            rating:  m.rating  || '',
            reviews: m.reviews || '',
          }});
        }
        log(`✅ Phase 2 done: Maps matched`, jobId);
      }

      updateJob(jobId, { progress: 65, currentCity: 'Phase 3/3 — Owner enrichment (TPS/WHOIS)...' });

      // ── Phase 3: Owner Enrichment ──
      const currentLeads = [...(getJob(jobId)?.leads || [])];
      let done = 0;

      for (const lead of currentLeads) {
        if (getJob(jobId)?.stopFlag) break;
        if (!lead.owner_name && !lead.website) { done++; continue; }

        const ownerData = await enrichOwner(lead, { log: (m) => log(m, jobId), jobId }).catch(() => ({}));

        if (ownerData.owner_cell || ownerData.owner_email) {
          updateJob(jobId, { enrichLead: {
            business_name:      lead.business_name,
            owner_cell:         ownerData.owner_cell         || '',
            owner_cell_source:  ownerData.owner_cell_source  || '',
            owner_email:        ownerData.owner_email        || '',
            owner_email_source: ownerData.owner_email_source || '',
            primary_email:      ownerData.owner_email        || lead.primary_email || '',
          }});
        }

        done++;
        updateJob(jobId, {
          progress:    65 + Math.floor((done / currentLeads.length) * 30),
          currentCity: `Enriching: ${lead.business_name}`,
        });
      }

      await closeEnricherBrowser().catch(() => {});

      const final = getJob(jobId);
      if (!final) return;

      const stats = {
        total:         final.leads.length,
        withOwnerName: final.leads.filter(l => l.owner_name).length,
        withOwnerCell: final.leads.filter(l => l.owner_cell).length,
        withEmail:     final.leads.filter(l => l.primary_email || l.owner_email).length,
        withPhone:     final.leads.filter(l => l.phone).length,
        highIntent:    final.leads.filter(l => l.intent === 'HIGH').length,
        mediumIntent:  final.leads.filter(l => l.intent === 'MEDIUM').length,
        lowIntent:     final.leads.filter(l => l.intent === 'LOW').length,
      };

      updateJob(jobId, { status: 'completed', progress: 100, stats });
      log(`✅ SOS complete: ${final.leads.length} leads | ${stats.withOwnerCell} with cell | ${stats.withEmail} with email`, jobId);

    } catch (err) {
      log(`❌ SOS Error: ${err.message}`, jobId);
      updateJob(jobId, { status: 'failed', error: err.message });
      await closeEnricherBrowser().catch(() => {});
    }
  })();
});

// =========================
// STOP
// =========================
// =========================
// STOP
// =========================
app.post('/stop/:id', (req, res) => {
  const jobId = req.params.id;
  setStopFlag(jobId, true);
  updateJob(jobId, { status: 'cancelled', cancelled: true });
  log(`🛑 Stop requested`, jobId);
  res.json({ status: 'stopping' });
});

// =========================
// PAUSE / RESUME
// =========================
app.post('/pause/:id', (req, res) => {
  setPauseFlag(req.params.id, true);
  log(`⏸️ Paused`, req.params.id);
  res.json({ status: 'paused' });
});

app.post('/resume/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  
  setPauseFlag(req.params.id, false);
  updateJob(req.params.id, { status: 'running' });
  log(`▶️ Resumed`, req.params.id);
  
  // Dead Resume: Server restarted and Playwright is gone. Restart it.
  if (job.workerRunning === false && job.niche !== 'CSV Upload') {
     job.workerRunning = true;
     // Re-trigger background async scrape, it will pick up from job.lastCityIndex
     (async () => {
        try {
          await scrapeGoogleMaps(
            job.niche,
            job.location,
            job.filterType,
            job.negativeKeywords || '',
            job.id,
            job.mode || 'hybrid',
            job.workers || 3,
            (progressData) => {
              const currentJob = getJob(job.id);
              if (!currentJob || currentJob.stopFlag) return;
              if (typeof progressData === 'number') {
                updateJob(job.id, { progress: progressData });
              } else {
                updateJob(job.id, {
                  progress: progressData.progress ?? currentJob.progress,
                  currentCity: progressData.city ?? currentJob.currentCity
                });
                if (progressData.leads && Array.isArray(progressData.leads)) {
                  progressData.leads.forEach(lead => updateJob(job.id, { leads: [lead] }));
                }
              }
            }
          );
          
          const finalJob = getJob(job.id);
          if (!finalJob) return;
          const highIntent   = finalJob.leads.filter(l => l.intent === 'HIGH').length;
          const mediumIntent = finalJob.leads.filter(l => l.intent === 'MEDIUM').length;
          const lowIntent    = finalJob.leads.filter(l => l.intent === 'LOW').length;
          const stats = { highIntent, mediumIntent, lowIntent, total: finalJob.leads.length };

          if (finalJob.stopFlag) {
            updateJob(job.id, { stats, workerRunning: false });
            return;
          }
          updateJob(job.id, { status: 'completed', progress: 100, stats, workerRunning: false });
          log(`✅ Completed Resumed Scan`, job.id);
        } catch (err) {
          log(`❌ Error Resuming: ${err.message}`, job.id);
          updateJob(job.id, { status: 'failed', error: err.message, workerRunning: false });
        }
     })();
  }
  
  res.json({ status: 'resumed' });
});

app.delete('/job/:id', (req, res) => {
  const jobId = req.params.id;
  deleteJob(jobId);
  res.json({ success: true });
});

// =========================
// PIN JOB
// =========================
app.post('/pin/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  
  updateJob(req.params.id, { pinned: !job.pinned });
  res.json({ success: true, pinned: !job.pinned });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});