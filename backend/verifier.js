import dns from 'dns/promises';
import net from 'net';

const CACHE = new Map();
const TIMEOUT = 5000;

const SMTP_PORTS = [25, 587]; // try fallback

export async function verifyEmail(email) {
  if (!email || !email.includes('@')) return 'not_found';

  const domain = email.split('@')[1];

  // =========================
  // CACHE
  // =========================
  if (CACHE.has(email)) {
    return CACHE.get(email);
  }

  try {
    const mxRecords = await dns.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      CACHE.set(email, 'not_found');
      return 'not_found';
    }

    const mxHost = mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;

    // =========================
    // SMTP CHECK (FAST)
    // =========================
    const result = await smtpCheck(email, mxHost);

    let status = 'risky';

    if (result === 250 || result === 251) status = 'verified';
    else if ([550, 551, 553].includes(result)) status = 'not_found';

    CACHE.set(email, status);
    return status;

  } catch (err) {
    return 'risky';
  }
}

async function smtpCheck(email, mxHost) {
  for (const port of SMTP_PORTS) {
    try {
      const code = await trySmtp(email, mxHost, port);
      if (code) return code;
    } catch {}
  }
  return null;
}

function trySmtp(email, mxHost, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let step = 0;
    let finished = false;

    const cleanup = () => {
      if (!finished) {
        finished = true;
        socket.destroy();
        resolve(null);
      }
    };

    socket.setTimeout(TIMEOUT);

    socket.connect(port, mxHost, () => {});

    socket.on('data', (data) => {
      const response = data.toString();
      const code = parseInt(response.slice(0, 3), 10);

      if (step === 0 && code === 220) {
        step = 1;
        socket.write('EHLO leadengine.com\r\n');
      } else if (step === 1 && code === 250) {
        step = 2;
        socket.write('MAIL FROM:<test@leadengine.com>\r\n');
      } else if (step === 2 && code === 250) {
        step = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (step === 3) {
        finished = true;
        socket.write('QUIT\r\n');
        socket.destroy();
        resolve(code);
      }
    });

    socket.on('timeout', cleanup);
    socket.on('error', cleanup);
    socket.on('close', cleanup);
  });
}