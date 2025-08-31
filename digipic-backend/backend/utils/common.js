// backend/utils/common.js
function chunk(arr, size = 10) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ymd(dLike) {
  const d = new Date(dLike);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function toMillis(ts) {
  return ts?.toMillis?.() ?? (typeof ts === 'number' ? ts : null);
}

module.exports = { chunk, ymd, toMillis };
