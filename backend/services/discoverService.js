// ═══════════════════════════════════════════════════════════════════════════════
// 🧭 Discover Service - Films and series from TMDB, to find something to watch
// ═══════════════════════════════════════════════════════════════════════════════
//
// Uses the TMDB key saved in the admin Settings (see metadataService). Every
// answer comes in the app language asked for ('en' or 'pt'); text missing in
// that language is taken from the next one in METADATA_LANGUAGES, then English.
//
// Items in lists:  { id, kind: 'movie' | 'tv', title, year, poster, backdrop, overview, rating }
// A film:          item + { imdbId, runtime, genres, cast, director }
// A series:        item + { imdbId, genres, cast, seasons: [{ number, name, episodes, poster, year }] }
// A season:        { number, name, overview, episodes: [{ number, title, overview, still, date, runtime, rating }] }

const config = require('../config/constants');
const metadataService = require('./metadataService');
const settingsService = require('./settingsService');

const CACHE_TTL = 60 * 60 * 1000; // TMDB answers change slowly
const CACHE_MAX = 500;

class DiscoverService {
  constructor() {
    this.cache = new Map(); // key -> { at, value }
  }

  key() {
    const key = settingsService.tmdbKey();
    if (!key) throw new Error('Add a TMDB key in the admin Settings to use Discover.');
    return key;
  }

  languages(lang) {
    return [...(config.METADATA_LANGUAGES[lang] || config.METADATA_LANGUAGES.en), 'en-US']
      .filter((language, i, all) => all.indexOf(language) === i);
  }

  // TMDB request, kept for a while (the same pages are asked for again and again)
  async get(path, params = {}) {
    const id = `${path}?${new URLSearchParams(params)}`;
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

    const value = await metadataService.tmdb(this.key(), path, params);
    this.cache.set(id, { at: Date.now(), value });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  // The same request in each language until the fields are filled
  async getFilled(path, lang, params, fields) {
    const languages = this.languages(lang);
    const first = await this.get(path, { ...params, language: languages[0] });
    let result = first;

    for (const language of languages.slice(1)) {
      if (fields.every(field => result[field])) break;
      const other = await this.get(path, { ...params, language });
      result = { ...result };
      for (const field of fields) if (!result[field] && other[field]) result[field] = other[field];
    }
    return result;
  }

  image(path, size) {
    return metadataService.image(path, size);
  }

  item(entry, kind = entry.media_type) {
    const date = entry.release_date || entry.first_air_date || '';
    return {
      id: entry.id,
      kind,
      title: entry.title || entry.name || '',
      year: date.slice(0, 4),
      poster: this.image(entry.poster_path, 'w342'),
      backdrop: this.image(entry.backdrop_path, 'w1280'),
      overview: entry.overview || '',
      rating: entry.vote_count ? Math.round(entry.vote_average * 10) / 10 : null
    };
  }

  list(data, kind) {
    return {
      items: (data.results || [])
        .filter(entry => (kind || entry.media_type) === 'movie' || (kind || entry.media_type) === 'tv')
        .map(entry => this.item(entry, kind || entry.media_type)),
      page: data.page || 1,
      totalPages: Math.min(data.total_pages || 1, 500),
      total: data.total_results || 0
    };
  }

  // ── Lists ────────────────────────────────────────────────────────────────

  // Rows of the opening page
  async home(lang) {
    const language = this.languages(lang)[0];
    const [trending, movies, series, topMovies, topSeries] = await Promise.all([
      this.get('/trending/all/week', { language }),
      this.get('/movie/popular', { language, region: lang === 'pt' ? 'PT' : '' }),
      this.get('/tv/popular', { language }),
      this.get('/movie/top_rated', { language }),
      this.get('/tv/top_rated', { language })
    ]);

    return [
      { id: 'trending', title: 'Trending this week', ...this.list(trending) },
      { id: 'movies', title: 'Popular films', ...this.list(movies, 'movie') },
      { id: 'series', title: 'Popular series', ...this.list(series, 'tv') },
      { id: 'top-movies', title: 'Top rated films', ...this.list(topMovies, 'movie') },
      { id: 'top-series', title: 'Top rated series', ...this.list(topSeries, 'tv') }
    ];
  }

  // One more page of a row of the opening page
  async row(id, page, lang) {
    const language = this.languages(lang)[0];
    const paths = {
      trending: ['/trending/all/week', null],
      movies: ['/movie/popular', 'movie'],
      series: ['/tv/popular', 'tv'],
      'top-movies': ['/movie/top_rated', 'movie'],
      'top-series': ['/tv/top_rated', 'tv']
    };
    if (!paths[id]) throw new Error('Unknown list');
    const [path, kind] = paths[id];
    return this.list(await this.get(path, { language, page }), kind);
  }

  // Films and series by name
  async search(query, page, lang, kind) {
    const language = this.languages(lang)[0];
    const path = kind === 'movie' ? '/search/movie' : kind === 'tv' ? '/search/tv' : '/search/multi';
    return this.list(await this.get(path, { query, page, language, include_adult: 'false' }), kind || null);
  }

  // ── Details ──────────────────────────────────────────────────────────────

  credits(credits) {
    const cast = ((credits && credits.cast) || []).slice(0, 6).map(person => person.name);
    const director = ((credits && credits.crew) || []).find(person => person.job === 'Director');
    return { cast, director: director ? director.name : '' };
  }

  async movie(id, lang) {
    const film = await this.getFilled(`/movie/${id}`, lang, { append_to_response: 'credits,external_ids' }, ['overview', 'title']);
    return {
      ...this.item(film, 'movie'),
      imdbId: film.imdb_id || (film.external_ids && film.external_ids.imdb_id) || '',
      originalTitle: film.original_title || '',
      runtime: film.runtime || 0,
      genres: (film.genres || []).map(g => g.name),
      ...this.credits(film.credits)
    };
  }

  async series(id, lang) {
    const show = await this.getFilled(`/tv/${id}`, lang, { append_to_response: 'credits,external_ids' }, ['overview', 'name']);
    return {
      ...this.item(show, 'tv'),
      imdbId: (show.external_ids && show.external_ids.imdb_id) || '',
      originalTitle: show.original_name || '',
      genres: (show.genres || []).map(g => g.name),
      ...this.credits(show.credits),
      // Specials (season 0) go last
      seasons: (show.seasons || [])
        .filter(season => season.episode_count > 0)
        .map(season => ({
          number: season.season_number,
          name: season.name || `Season ${season.season_number}`,
          episodes: season.episode_count,
          poster: this.image(season.poster_path, 'w342'),
          year: (season.air_date || '').slice(0, 4)
        }))
        .sort((a, b) => (a.number || 999) - (b.number || 999))
    };
  }

  async season(id, number, lang) {
    const season = await this.getFilled(`/tv/${id}/season/${number}`, lang, {}, ['overview']);
    const languages = this.languages(lang);

    // Episode titles and synopses missing in the language asked for come from the next one
    let episodes = season.episodes || [];
    for (const language of languages.slice(1)) {
      if (episodes.every(ep => ep.overview && ep.name && !/^(episode|episódio|episodio)\s+\d+$/i.test(ep.name))) break;
      const other = await this.get(`/tv/${id}/season/${number}`, { language });
      const byNumber = new Map((other.episodes || []).map(ep => [ep.episode_number, ep]));
      episodes = episodes.map(ep => {
        const alt = byNumber.get(ep.episode_number) || {};
        const generic = /^(episode|episódio|episodio)\s+\d+$/i.test(ep.name || '');
        return {
          ...ep,
          name: (!ep.name || generic) && alt.name ? alt.name : ep.name,
          overview: ep.overview || alt.overview || ''
        };
      });
    }

    return {
      number: season.season_number,
      name: season.name || `Season ${number}`,
      overview: season.overview || '',
      episodes: episodes.map(ep => ({
        number: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        overview: ep.overview || '',
        still: this.image(ep.still_path, 'w300'),
        date: ep.air_date || '',
        runtime: ep.runtime || 0,
        rating: ep.vote_count ? Math.round(ep.vote_average * 10) / 10 : null
      }))
    };
  }
}

module.exports = new DiscoverService();
