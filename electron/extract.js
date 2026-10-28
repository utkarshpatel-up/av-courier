// Reads a request (WhatsApp message, email, pasted text, screenshot) and pulls
// out what the catalogue can be searched with. Works offline with patterns; with
// a Claude API key it also reads images and loosely worded requests.
const { ids, dates } = require('./catalog');

// A request = someone asking (English, or the Gujarati/Hindi "joie che", "mokalo",
// "bhejo", "chahiye") for archive material. Asking words alone are not enough:
// bank, bill and delivery messages "request", say "please" and carry dates too.
const ASK = /\b(need|needed|send|share|give|want|require|required|request|can you|joie|joiye|joiae|joiti|jove|mokal\w*|moklo|bhej\w*|chahiye|chaiye|chahie|aapo|apo|apjo|aapjo|aapsho|mangta|dedo|de do)\b/gi;
// The same in Gujarati and Hindi script ("જોઈએ છે", "મોકલજો", "चाहिए"): \b does not work there.
const ASK_SCRIPT = /(જોઈએ|જોઇએ|જોઈએ|જોઇતા|જોઈતા|મોકલ\S*|આપજો|આપશો|મૂકી દે\S*|મુકી દે\S*|चाहिए|चाहिये|भेज\S*|दीजिए|दीजिये|दे दो)/g;
const ARCHIVE_SCRIPT = /(સત્સંગ|સત્સંગ|વિડિયો|વિડીયો|વીડિયો|રેકોર્ડિંગ|શિબિર|सत्संग|वीडियो|विडियो|रिकॉर्डिंग|शिबिर)/g;
// Politeness is not asking: "Please plan the video setup" is an instruction.
const POLITE = /\b(please|pls|plz|kindly)\b/gi;
const ARCHIVE = /\b(footage|videos?|clips?|recordings?|raw|data|satsang|katha|shibir|parayan|episodes?|audio|program(me)?|darshan|vidhi|gnanvidhi|aptavani|vitraag|janma ?jayanti|guru ?purnima|bhakti|pratikraman|master|mini ?dv|dvcam|lto|tape|hdd|ssd)\b/gi;
const ARCHIVE_WEAK = /\b(files?|photos?|folder|drive|copy)\b/gi;
// Money, shopping and service messages: never a data request on their own.
const NOISE = /\b(bill|billing|payment|pay now|due|credit|debit|card|bank|emi|loan|invoice|premium|policy|insurance|otp|offer|cashback|order|delivered|delivery|refund|return request|recharge|kyc|a\/c|account|upi|transaction|statement|renewal|dear customer|subscribe|unsubscribe|reward|coupon|sale|discount|video calls?|for free)\b|₹|\brs\.?\s*\d|\binr\b|https?:\/\//gi;
// WhatsApp wraps previews in direction marks (U+202A … U+202C) and other invisible characters.
const clean = (s) => String(s || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '').trim();

function heuristic(text) {
  const t = clean(text);
  const count = (re) => new Set((t.match(re) || []).map((w) => w.toLowerCase())).size;
  const ask = count(ASK) + count(ASK_SCRIPT), archive = count(ARCHIVE) + count(ARCHIVE_SCRIPT) + count(ARCHIVE_WEAK) / 2, noise = count(NOISE);
  const foundIds = ids(t).filter((id) => /^(hdd|hd|drive|d|disk|ssd|tape|t|lto|dv|bt)\d+$/.test(id));
  const foundDates = dates(t);
  const years = (t.match(/\b(19[5-9]\d|20\d\d)\b/g) || []).length;
  const numbers = [...t.matchAll(/\b(?:drive|hdd|disk|ssd|tape|lto)\s*(?:no\.?|number|#)?\s*0*(\d{1,6})\b/gi)].map((m) => m[1]);
  // Raw Video Ids, folder or episode numbers name a recording outright.
  const strong = /\b[A-Z]{2,4}(?:,\s*[A-Z]{2,4})?-[FI]-(?:HD|4K|DV)-\d{3,5}\b/i.test(t)
    || /\b(folder|episode|ep)\s*(?:no\.?|number|#)?\s*\d{1,5}\b/i.test(t)
    || (foundIds.length > 0 && ask > 0);
  let score = Math.min(48, ask * 12) + Math.min(6, count(POLITE) * 6) + Math.min(40, archive * 14) + foundIds.length * 20 + Math.min(2, foundDates.length) * 8 + Math.min(1, years) * 6 + (strong ? 40 : 0) - noise * 15;
  if (/\?$/.test(t) && ask) score += 5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const isRequest = strong || (ask > 0 && archive >= 1 && noise === 0) || (ask > 0 && archive >= 2 && noise <= 1);
  return {
    score: isRequest ? Math.max(score, 30) : Math.min(score, 23),
    isRequest,
    ids: foundIds,
    numbers,
    dates: foundDates,
    keywords: [],
    summary: t.split('\n')[0].slice(0, 140),
    source: 'patterns',
  };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_data_request', 'confidence', 'summary', 'drive_numbers', 'tape_numbers', 'folder_numbers', 'video_ids', 'dates', 'keywords', 'places', 'people', 'search_text'],
  properties: {
    is_data_request: { type: 'boolean', description: 'True if the sender is asking for recordings/footage/files to be found, copied or sent.' },
    confidence: { type: 'integer', description: '0-100' },
    summary: { type: 'string', description: 'One line, what they want, in English.' },
    drive_numbers: { type: 'array', items: { type: 'string' } },
    tape_numbers: { type: 'array', items: { type: 'string' } },
    folder_numbers: { type: 'array', items: { type: 'string' }, description: 'Archive folder numbers ("folder 3049")' },
    video_ids: { type: 'array', items: { type: 'string' }, description: 'Raw video ids like DD-F-4K-3049-E' },
    dates: { type: 'array', items: { type: 'string' }, description: 'Dates of the recordings asked for: yyyy-mm-dd, or yyyy-mm / yyyy when only the month or year is known' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Event type, topic, speaker or place words likely to appear in the catalogue (e.g. Gurupurnima, Janma Jayanti, Shibir, Parayan, Aptavani, Soneri Satsang, Garba, a city)' },
    places: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    search_text: { type: 'string', description: 'A short catalogue search string combining the strongest terms' },
  },
};

const SYSTEM = `You triage incoming messages for an audio/video archive operator. People ask for recordings
in any language mix (English, Gujarati, Hindi transliterated), often without drive or tape numbers.
Extract what is needed to find the recording in the catalogue. Catalogue rows have a raw video id
(e.g. DD-F-4K-3049-E: author DD/NM/DJM, F=formal or I=informal, format HD/4K/DV, folder number, session),
a folder number, the day/month/year, city, event type (Gurupurnima, Janma Jayanti, Shibir, Parayan,
Soneri Satsang, Navratri...), a topic, and backup media names (DD MASTER SSD - 123, LTO, HDD, NAS).
DD is Pujyashree Deepakbhai Desai, NM is Pujya Niruma. In old terms MASTER means formal and MINI DV
means informal. Folder numbers run separately per author and formal/informal in the DV years
(until 2013) and restart for HD/4K from 2013, so keep words like "NM", "DD", "master", "mini dv",
"informal", "DV", "HD" in keywords when the sender uses them.
Edited episodes belong to series such as "DD Vitraag", "DD Hindi", "DD English", "DD MBA",
"Aptavani-14-B2": put the series name and the episode number in search_text ("DD Vitraag 2350").
Screenshots may show a chat, a poster, a programme list or a file browser: read them.
Today's date is ${new Date().toISOString().slice(0, 10)}; resolve relative dates ("last Sunday") against it.`;

async function withClaude({ text, images = [], apiKey }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const content = [];
  for (const img of images.slice(0, 5)) {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(img);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: `Message:\n"""\n${text || '(image only)'}\n"""` });

  const params = {
    model: 'claude-opus-5-5',
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  let res;
  try {
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e?.status !== 400) throw e;
    res = await client.messages.create(params); // account without the fallback beta
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to read this message');
  const out = JSON.parse(res.content.find((b) => b.type === 'text')?.text || '{}');
  return {
    score: out.is_data_request ? Math.max(50, out.confidence) : Math.min(30, out.confidence),
    isRequest: !!out.is_data_request,
    ids: [...out.drive_numbers.flatMap((d) => ids(d).length ? ids(d) : [`drive${+d || d}`]), ...out.tape_numbers.flatMap((t) => ids(t).length ? ids(t) : [`tape${+t || t}`])],
    numbers: [...out.drive_numbers, ...out.tape_numbers].map((n) => (String(n).match(/\d+/) || [])[0]).filter(Boolean),
    dates: out.dates,
    keywords: [...out.keywords, ...out.places, ...out.people],
    searchText: [out.search_text, ...out.folder_numbers.map((n) => `folder ${n}`), ...out.video_ids].filter(Boolean).join(' '),
    summary: out.summary,
    source: 'claude',
  };
}

async function analyse({ text, images = [], apiKey }) {
  const base = heuristic(text);
  if (!apiKey) return base;
  try {
    const ai = await withClaude({ text, images, apiKey });
    return { ...ai, ids: [...new Set([...ai.ids, ...base.ids])], dates: [...new Set([...ai.dates, ...base.dates])], numbers: [...new Set([...ai.numbers, ...base.numbers])] };
  } catch (e) {
    return { ...base, aiError: e.message };
  }
}

// A request that lists several recordings ("1) … 2) …", "• …"): one text per item, so each
// is searched on its own and a strong item cannot crowd out the others. A wrapped item keeps
// its following lines; a blank line ends it. Fewer than two items: the whole text.
const ITEM = /^\s*(?:\(?\d{1,2}[).]|[a-h]\)|[•*▪●◦])\s+/i;
function requestItems(text) {
  const items = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    if (ITEM.test(l)) { if (cur) items.push(cur); cur = l.replace(ITEM, ''); }
    else if (!l) { if (cur) items.push(cur); cur = null; }
    else if (cur != null) cur += ' ' + l;
  }
  if (cur) items.push(cur);
  return items.length >= 2 ? items : [String(text || '')];
}

// A request's catalogue matches. a: what analyse() read from the whole text. A list of
// recordings is searched item by item, then taken in turns (each item's best, then each
// item's second…), so every item shows near the top. Mirrored by Catalog.forRequest on the phone.
function searchRequest(catalog, text, a = heuristic(text), limit = 15) {
  const items = requestItems(text);
  if (items.length < 2) return catalog.search({ text: a.searchText || text, ids: a.ids, numbers: a.numbers, dates: a.dates, keywords: a.keywords }, limit);
  const per = items.map((t) => { const h = heuristic(t); return catalog.search({ text: t, ids: h.ids, numbers: h.numbers, dates: h.dates }, limit); });
  const cap = Math.min(30, Math.max(limit, items.length * 4));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < limit; i++) {
    for (const list of per) {
      const m = list[i];
      const k = m && `${m.file}|${m.sheet}|${m.row}`;
      if (m && !seen.has(k) && out.length < cap) { seen.add(k); out.push(m); }
    }
  }
  return out;
}

// What was asked for, item by item, each with its own best catalogue rows: the draft of a
// request's checklist. One item when the message is not a list.
function requestAsks(catalog, text, a = heuristic(text), per = 3) {
  const items = requestItems(text);
  if (items.length < 2) return [{ ask: a.summary || String(text || '').trim().slice(0, 200), matches: catalog.search({ text: a.searchText || text, ids: a.ids, numbers: a.numbers, dates: a.dates, keywords: a.keywords }, per) }];
  return items.map((t) => { const h = heuristic(t); return { ask: t.slice(0, 200), matches: catalog.search({ text: t, ids: h.ids, numbers: h.numbers, dates: h.dates }, per) }; });
}

module.exports = { analyse, heuristic, withClaude, requestItems, searchRequest, requestAsks };
