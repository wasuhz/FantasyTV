// The IPTV guide, read off the page's thread: guides run to tens of MB (60 MB on one provider), and parsing one on the
// page froze the TV's controls for 25 s on lower-powered boxes. This reads it as it downloads and keeps only what's on
// the air now: {channel id: its text (title, subtitle, description), lower case}.
// Message in: {url, now}. Out: {now: {...}} or {error}.

self.onmessage = async ({ data: { url, now } }) => {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`IPTV ${r.status}`);
    const out = {};
    const take = block => {
      const attr = k => (new RegExp(`\\b${k}="([^"]*)"`).exec(block) || [])[1];
      const start = xmltvTime(attr('start')), stop = xmltvTime(attr('stop'));
      if (!(start <= now && now < stop)) return;
      const id = decode(attr('channel') || '');
      let t = '';
      for (const m of block.matchAll(/<(title|sub-title|desc)\b[^>]*>([\s\S]*?)<\/\1>/g)) t += ' ' + decode(m[2]);
      out[id] = ((out[id] || '') + t).toLowerCase();
    };
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: !done });
      let end;
      while ((end = buf.indexOf('</programme>')) >= 0) {
        const from = buf.lastIndexOf('<programme', end);
        if (from >= 0) take(buf.slice(from, end));
        buf = buf.slice(end + 12);
      }
      // Keep only an unfinished programme (the channel list before them, and anything else, goes).
      const open = buf.lastIndexOf('<programme');
      buf = open >= 0 ? buf.slice(open) : buf.slice(-64);
      if (done) break;
    }
    self.postMessage({ now: out });
  } catch (e) {
    self.postMessage({ error: String((e && e.message) || e) });
  }
};

function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return NaN;
  const tz = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]);
}
