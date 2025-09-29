function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number')) return null;
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function isBoostActive(user) {
  return user?.boostExpiresAt && new Date(user.boostExpiresAt) > new Date();
}

module.exports = { haversineKm, isBoostActive };
