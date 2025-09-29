// /public/js/page-advanced-search.js
document.addEventListener('click', (e) => {
  const locked = e.target.closest('[data-locked]');
  if (locked) {
    e.preventDefault();
    e.stopPropagation();
    const feature = locked.getAttribute('data-locked');
    // subtle nudge—replace with your modal if you have one
    alert(`“${feature}” is a Premium filter. Upgrade to unlock.`);
    window.location.href = '/upgrade';
  }
});

// Optional: protect distance sort if gated but not disabled by HTML (older browsers)
const sortSel = document.querySelector('[data-lock-distance]');
if (sortSel) {
  sortSel.addEventListener('change', (e) => {
    if (sortSel.querySelector('option[value="distance"]')?.disabled) {
      e.target.value = 'active';
      alert('Distance sort is Premium.');
      location.assign('/upgrade');
    }
  });
}
