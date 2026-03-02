export function getDateRange(days, offsetDays = 0) {
  const end = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString().split('T')[0], endDate: end.toISOString().split('T')[0] };
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDuration(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins + 'm ' + secs + 's';
}

export function formatIssueStatus(status) {
  const map = {
    'Submitted and indexed': 'Indexed',
    'Crawled - currently not indexed': 'Crawled but not indexed',
    'Discovered - currently not indexed': 'Discovered but not indexed',
    'URL is unknown to Google': 'Unknown to Google',
    'Excluded by noindex tag': 'Blocked by noindex',
    'Blocked by robots.txt': 'Blocked by robots.txt',
    'Blocked due to unauthorized request (401)': '401 Unauthorized',
    'Not found (404)': '404 Not Found',
    'Blocked due to access forbidden (403)': '403 Forbidden',
    'Blocked due to other 4xx issue': '4xx Error',
    'Server error (5xx)': '5xx Server Error',
    'Redirect error': 'Redirect Error',
    'Soft 404': 'Soft 404',
    'Duplicate without user-selected canonical': 'Duplicate (no canonical)',
    'Duplicate, Google chose different canonical than user': 'Canonical mismatch',
    'Page with redirect': 'Redirected',
    'Alternate page with proper canonical tag': 'Alternate page'
  };
  return map[status] || status;
}

export function formatIssueMessage(type, count) {
  const messages = {
    missing_title: `${count} page(s) missing title tag`,
    short_title: `${count} page(s) with short titles`,
    missing_description: `${count} page(s) missing meta description`,
    short_description: `${count} page(s) with short descriptions`,
    missing_h1: `${count} page(s) missing H1 tag`,
    multiple_h1: `${count} page(s) with multiple H1 tags`,
    missing_schema: `${count} page(s) without structured data`,
    schema_error: `${count} page(s) with invalid schema`
  };
  return messages[type] || `${count} ${type} issue(s)`;
}
