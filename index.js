const AJAX_URL = 'https://www.snapyt.app/wp-admin/admin-ajax.php';
const SITE = 'https://www.snapyt.app/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': SITE,
  'Origin': 'https://www.snapyt.app',
  'User-Agent': UA,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=UTF-8',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

async function getNonce() {
  const response = await fetch(AJAX_URL, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: 'action=vd_fresh_nonce',
  });
  if (!response.ok) throw new Error(`Nonce HTTP error: ${response.status}`);
  const cookies = response.headers.get('set-cookie') || '';
  const j = await response.json();
  if (!j.success || !j.data?.nonce) throw new Error('Could not get nonce');
  return { nonce: j.data.nonce, cookies };
}

async function submitVideo(videoUrl, nonce, cookies) {
  const body = new URLSearchParams({
    action: 'process_video_url',
    video_url: videoUrl,
    security: nonce,
  });
  const headers = { ...BASE_HEADERS };
  if (cookies) headers['Cookie'] = cookies;

  const response = await fetch(AJAX_URL, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(`Submit HTTP error: ${response.status}`);
  const j = await response.json();
  if (!j.success || !j.data?.redirect) {
    throw new Error('Submit failed: ' + JSON.stringify(j));
  }
  return j.data.redirect;
}

async function getPreviewHtml(previewUrl, cookies) {
  const headers = { 'User-Agent': UA, 'Referer': SITE };
  if (cookies) headers['Cookie'] = cookies;

  const response = await fetch(previewUrl, { headers });
  if (!response.ok) throw new Error('Preview fetch failed: ' + response.status);
  return response.text();
}

function parseFormats(html) {
  const formats = [];
  const re = /<option\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const value = /value="(\d+)"/i.exec(tag);
    if (!value) continue;

    const label = /data-label="([^"]*)"/i.exec(tag);
    const size = /data-size="([^"]*)"/i.exec(tag);
    const kind = /data-kind="([^"]*)"/i.exec(tag);
    const force = /data-force="([^"]*)"/i.exec(tag);

    formats.push({
      fmt: parseInt(value[1], 10),
      label: label ? label[1].replace(/\s+/g, ' ').trim() : `Format ${value[1]}`,
      size: size ? size[1].trim() : '',
      kind: kind ? kind[1].trim() : 'video+audio',
      download: force
        ? force[1].replace(/&#038;|&#x26;|&amp;/gi, '&')
        : null,
    });
  }

  const seen = new Set();
  return formats.filter(f => (seen.has(f.fmt) ? false : (seen.add(f.fmt), true)));
}

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const fullUrl = `${protocol}://${req.headers.host}${req.url}`;
  const urlObj = new URL(fullUrl);
  const pathname = urlObj.pathname;

  // ১. ফরম্যাট ফেচ করার রুট
  if (pathname === '/' || pathname === '/api/formats') {
    const videoUrl = urlObj.searchParams.get('url');
    if (!videoUrl) {
      return jsonResponse(res, { error: 'Missing ?url= parameter' }, 400);
    }

    try {
      const { nonce, cookies } = await getNonce();
      const previewUrl = await submitVideo(videoUrl, nonce, cookies);
      const html = await getPreviewHtml(previewUrl, cookies);
      const formats = parseFormats(html);

      return jsonResponse(res, { success: true, formats });
    } catch (e) {
      return jsonResponse(res, { error: e.message }, 500);
    }
  }

  // ২. নতুন প্রক্সি রাউট (/proxy?url=...) যা সরাসরি স্ন্যাপাইটের ফাইল স্ট্রিম করবে
  if (pathname === '/proxy') {
    const targetUrl = urlObj.searchParams.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Missing ?url= parameter');
      return;
    }

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': SITE,
          'Origin': SITE,
        },
      });

      if (!response.ok) {
        res.writeHead(response.status, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
        res.end(`Proxy fetch failed with status ${response.status}`);
        return;
      }

      // অরিজিনাল ফাইলের হেডার্স (Content-Type, Content-Length ইত্যাদি) ব্রাউজারে পাস করে দেওয়া
      const resHeaders = {
        ...CORS_HEADERS,
        'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
      };
      if (response.headers.get('content-length')) {
        resHeaders['Content-Length'] = response.headers.get('content-length');
      }

      res.writeHead(200, resHeaders);

      // বাইনারি স্ট্রিম পাইপ করে ব্রাউজারে পাঠিয়ে দেওয়া
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Proxy Error: ' + err.message);
    }
    return;
  }

  return jsonResponse(res, { error: 'Not Found' }, 404);
}