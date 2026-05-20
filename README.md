# Lead Gen Fullstack

## Backend Setup (d:/Lead_Project/backend)
```
cd backend
npm install
npx playwright install chromium
node server.js
```
API: localhost:3001

## Frontend Setup (d:/Lead_Project/frontend)
```
cd frontend
npm install
npm run dev
```
UI: localhost:3000

## Full Dev
```
npm run dev
```

**Test API**:
```
curl -X POST http://localhost:3001/scrape -H "Content-Type: application/json" -d "{\"niche\":\"plumbers\",\"location\":\"Toronto\"}"
curl http://localhost:3001/results/[jobId]
```

Expect 500+ leads, stable scraping!
