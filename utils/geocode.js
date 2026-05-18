/**
 * Geocode a plain-text address using Nominatim (OpenStreetMap, no API key).
 * Tries progressively broader sub-queries (city, country) if the full address
 * fails — handles typos and informal formats gracefully.
 * Returns { lat, lng } or null if nothing resolves.
 */

async function tryQuery(query) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'TradeLink/1.0 contact@tradelink.app' },
    });
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch { /* network error — fall through */ }
  return null;
}

export async function geocodeAddress(address) {
  // Split "1 hsahlom st, tel aviv, israel" → ["1 hsahlom st", "tel aviv", "israel"]
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);

  // Build attempts from most-specific to least-specific
  const attempts = [];
  for (let i = 0; i < parts.length; i++) {
    attempts.push(parts.slice(i).join(', '));
  }

  // Deduplicate and try each in order
  for (const query of [...new Set(attempts)]) {
    const result = await tryQuery(query);
    if (result) return result;
  }
  return null;
}
