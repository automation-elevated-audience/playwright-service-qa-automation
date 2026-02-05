# Playwright Link Checker Service

A standalone Node.js service that uses Playwright to check broken links and security attributes on web pages.

## Features

- Checks all links on a page for broken status (404, 500, etc.)
- Validates external links have proper security attributes (noopener/noreferrer)
- Parallel processing for multiple pages
- RESTful API endpoint
- CORS enabled for frontend integration

## Installation

```bash
cd playwright-service
npm install
```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The service will start on port 3001 (or PORT from .env file).

## API Endpoints

### Health Check
```
GET /health
```

Response:
```json
{
  "status": "healthy",
  "service": "playwright-link-checker",
  "timestamp": "2026-01-31T12:00:00.000Z"
}
```

### Check Links
```
POST /check-links
```

Request Body:
```json
{
  "pages": [
    {
      "url": "https://example.com/page1",
      "pageName": "Page 1"
    },
    {
      "url": "https://example.com/page2",
      "pageName": "Page 2"
    }
  ]
}
```

Query Parameters:
- `concurrency` (optional): Number of pages to check concurrently (default: 1)

Response:
```json
{
  "success": true,
  "results": [
    {
      "url": "https://example.com/page1",
      "pageName": "Page 1",
      "linkChecks": {
        "overall": "FAIL",
        "externalLinks": 10,
        "internalLinks": 20,
        "totalLinks": 30,
        "brokenLinks": [],
        "brokenCount": 0,
        "missingNoopener": 7,
        "linksWithoutNoopener": ["https://external.com"],
        "securityIssue": true,
        "issue": "7 external links are missing noopener/noreferrer attributes",
        "missingNewTab": 0
      }
    }
  ],
  "metadata": {
    "totalPages": 1,
    "duration": "5234ms",
    "timestamp": "2026-01-31T12:00:00.000Z"
  }
}
```

## Environment Variables

Create a `.env` file:

```env
PORT=3001
NODE_ENV=development
REQUEST_TIMEOUT=30000
MAX_CONCURRENCY=1
```

## Integration with Frontend

The frontend should call this service before sending data to the n8n webhook:

```javascript
const response = await axios.post('http://localhost:3001/check-links', {
  pages: [
    { url: 'https://example.com/page1', pageName: 'Page 1' }
  ]
});

const linkCheckResults = response.data.results;
```

## Notes

- The service processes pages in batches to avoid overwhelming the target server
- Each link check has a 5-second timeout
- Results are limited to 10 URLs for broken links and missing noopener lists
- External links are validated for security attributes (rel="noopener noreferrer")
