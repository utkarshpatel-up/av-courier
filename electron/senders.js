// Senders whose messages are never data requests: WhatsApp verified businesses (spotted
// by their badge in WhatsApp Web's chat list) and senders you chose to ignore. The phone
// app (Senders.kt) applies the same lists with the same matching.
const strip = (s) => String(s || '').replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
const norm = (s) => strip(s).toLowerCase().replace(/\s+/g, ' ').trim();

// "whatsapp:urban company", "email:alerts@bank.in" (by name when the address is unknown).
function senderKey(channel, from = {}) {
  return channel === 'email' ? `email:${norm(from.address || from.name)}` : `whatsapp:${norm(from.chat || from.name)}`;
}

// lists: { verified: [chat titles], ignored: [{ key, name, channel }] }. '' when the message may be a request.
function ignoredReason(msg, { verified = [], ignored = [] } = {}) {
  const channel = msg.channel === 'email' ? 'email' : 'whatsapp';
  const key = senderKey(channel, msg.from);
  if (key.endsWith(':')) return '';
  if (channel === 'whatsapp' && verified.some((v) => `whatsapp:${norm(v)}` === key)) return 'verified business';
  if (ignored.some((i) => i.key === key)) return 'ignored sender';
  // An email caught on the phone has only the sender's name.
  if (channel === 'email' && msg.from?.name) {
    const n = norm(msg.from.name);
    if (ignored.some((i) => i.channel === 'email' && (i.key === `email:${n}` || norm(i.name) === n || (i.display && norm(i.display) === n)))) return 'ignored sender';
  }
  return '';
}

module.exports = { senderKey, ignoredReason, norm };
