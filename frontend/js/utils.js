// ═══════════════════════════════════════════════════════════════════════════════
// 🛠️ Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

const utils = {
  // Get icon for genre based on name
  getIconForGenre(title) {
    const lower = title.toLowerCase();
    
    // Sport
    if (lower.includes('desport') || lower.includes('sport')) return '⚽';
    
    // Kids
    if (lower.includes('infant') || lower.includes('kids') || lower.includes('criança')) return '🧒';
    
    // Movies
    if (lower.includes('film') || lower.includes('movie') || lower.includes('cine')) return '🎥';
    
    // Documentaries
    if (lower.includes('document')) return '🎬';
    
    // News
    if (lower.includes('notíc') || lower.includes('news') || lower.includes('informa')) return '📰';
    
    // Music
    if (lower.includes('música') || lower.includes('music')) return '🎵';
    
    // Series
    if (lower.includes('séri') || lower.includes('series')) return '📽️';
    
    // Entertainment
    if (lower.includes('entreten')) return '🎭';
    
    // Religious
    if (lower.includes('religios')) return '⛪';
    
    // Regional
    if (lower.includes('regional') || lower.includes('local')) return '🏘️';
    
    // Generalist
    if (lower.includes('general')) return '📺';
    
    // Adult
    if (lower.includes('adult') || lower.includes('+18') || lower.includes('18+')) return '🔞';
    
    // International
    if (lower.includes('internacional') || lower.includes('inter')) return '🌍';
    
    // Country codes
    if (lower.includes('brasil') || lower.includes('brazil')) return '🇧🇷';
    if (lower.includes('espan') || lower.includes('spain')) return '🇪🇸';
    if (lower.includes('frança') || lower.includes('france')) return '🇫🇷';
    if (lower.includes('uk') || lower.includes('reino unido')) return '🇬🇧';
    if (lower.includes('usa') || lower.includes('estados unidos')) return '🇺🇸';
    if (lower.includes('portug')) return '🇵🇹';
    
    return '📁'; // default
  },
  
  // Format duration from seconds
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  },
  
  // Debounce function
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },
  
  // Log safely (no sensitive data)
  log: {
    info: () => {}, // Silent in production
    error: (msg) => console.error('Error:', msg),
    player: () => {} // Silent
  }
};

window.utils = utils;
