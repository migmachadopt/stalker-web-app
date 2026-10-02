// ═══════════════════════════════════════════════════════════════════════════════
// 🎞️ Metadata Service - Film and episode details for recordings in the library
// ═══════════════════════════════════════════════════════════════════════════════
//
// The user pastes the link of the film or episode (IMDb or TMDB) and the details
// are read once and kept with the recording.
//
// TMDB (themoviedb.org) is used when the admin has saved a key in Settings: it
// finds an IMDb link's exact episode and has titles and synopses in Portuguese
// and English. Both languages are kept, so the app can show the one chosen.
//
// Without a key, IMDb links still work through IMDb's search suggestions, which
// only give the English title, a picture and the year.
//
// Stored shape:
//   { source, kind: 'movie' | 'episode', link, imdbId, tmdbId, showTmdbId,
//     season, episode, year, date, runtime, rating, image, poster, linkedAt,
//     text: { en: { title, showTitle, overview, genres }, pt: { ... } } }

const axios = require('axios');
const config = require('../config/constants');
const logger = require('../utils/logger');
const settingsService = require('./settingsService');

const TIMEOUT = 15000;

class MetadataService {
  // What a pasted link points to
  parseLink(link) {
    const text = String(link || '').trim();

    const imdb = text.match(/\b(tt\d{6,})\b/);
    if (imdb) return { imdbId: imdb[1] };

    const episode = text.match(/themoviedb\.org\/tv\/(\d+)[^/]*\/season\/(\d+)\/episode\/(\d+)/);
    if (episode) return { showTmdbId: +episode[1], season: +episode[2], episode: +episode[3] };

    if (/themoviedb\.org\/tv\/\d+/.test(text)) {
      throw new Error('This is the link of a whole series. Open the episode and paste its link.');
    }

    const movie = text.match(/themoviedb\.org\/movie\/(\d+)/);
    if (movie) return { tmdbId: +movie[1] };

    throw new Error('Paste the link of the film or episode on IMDb or TMDB.');
  }

  async lookup(link) {
    const target = this.parseLink(link);
    const key = settingsService.tmdbKey();

    if (key) return this.fromTmdb(target, key);
    if (target.imdbId) return this.fromImdb(target.imdbId);

    throw new Error('TMDB links need a TMDB key in the admin Settings. An IMDb link works without one.');
  }

  // ── TMDB ─────────────────────────────────────────────────────────────────

  // Both kinds of TMDB key work: the short API key and the long read access token
  async tmdb(key, path, params = {}) {
    const bearer = /^eyJ/.test(key);

    try {
      const response = await axios.get(`${config.TMDB_API}${path}`, {
        params: bearer ? params : { ...params, api_key: key },
        headers: bearer ? { Authorization: `Bearer ${key}` } : {},
        timeout: TIMEOUT
      });
      return response.data;
    } catch (error) {
      const status = error.response && error.response.status;
      if (status === 401) throw new Error('TMDB did not accept the key saved in Settings.');
      if (status === 404) throw new Error('TMDB does not know this title.');
      throw new Error(`TMDB could not be reached (${status || error.code || error.message}).`);
    }
  }

  async checkKey(key) {
    try {
      await this.tmdb(key, '/configuration');
    } catch (error) {
      throw new Error(/did not accept/.test(error.message) ? 'TMDB did not accept this key. Check that it was copied whole.' : error.message);
    }
  }

  async fromTmdb(target, key) {
    let { tmdbId, showTmdbId, season, episode } = target;

    // An IMDb link: ask TMDB which film or episode it is
    if (target.imdbId) {
      const found = await this.tmdb(key, `/find/${target.imdbId}`, { external_source: 'imdb_id' });
      const film = (found.movie_results || [])[0];
      const ep = (found.tv_episode_results || [])[0];

      if (film) {
        tmdbId = film.id;
      } else if (ep) {
        showTmdbId = ep.show_id;
        season = ep.season_number;
        episode = ep.episode_number;
      } else if ((found.tv_results || []).length) {
        throw new Error('This is the link of a whole series. Open the episode and paste its link.');
      } else {
        throw new Error('TMDB does not know this IMDb title yet.');
      }
    }

    return tmdbId ? this.tmdbMovie(key, tmdbId) : this.tmdbEpisode(key, showTmdbId, season, episode);
  }

  // Reads one language after another (Portugal first, then Brazil) and keeps
  // the first non-empty value of each field
  async inLanguages(languages, read) {
    const empty = (value) => !value || (Array.isArray(value) && !value.length);
    const text = {};

    for (const language of languages) {
      const found = await read(language);
      for (const [field, value] of Object.entries(found)) {
        if (empty(text[field])) text[field] = value;
      }
      if (text.title && text.overview) break;
    }
    return text;
  }

  async allLanguages(read) {
    const text = {};
    for (const [app, languages] of Object.entries(config.METADATA_LANGUAGES)) {
      text[app] = await this.inLanguages(languages, read);
    }
    return text;
  }

  image(path, size) {
    return path ? `${config.TMDB_IMAGES}/${size}${path}` : '';
  }

  async tmdbMovie(key, id) {
    const base = await this.tmdb(key, `/movie/${id}`, { language: 'en-US' });

    const text = await this.allLanguages(async (language) => {
      const film = language === 'en-US' ? base : await this.tmdb(key, `/movie/${id}`, { language });
      return {
        title: film.title || '',
        overview: film.overview || '',
        genres: (film.genres || []).map(g => g.name),
        poster: this.image(film.poster_path, 'w342')
      };
    });

    return this.finish({
      source: 'tmdb',
      kind: 'movie',
      link: base.imdb_id ? `https://www.imdb.com/title/${base.imdb_id}/` : `https://www.themoviedb.org/movie/${id}`,
      imdbId: base.imdb_id || '',
      tmdbId: id,
      year: (base.release_date || '').slice(0, 4),
      date: base.release_date || '',
      runtime: base.runtime || 0,
      rating: base.vote_count ? Math.round(base.vote_average * 10) / 10 : null,
      image: this.image(base.backdrop_path, 'w780'),
      poster: this.image(base.poster_path, 'w342'),
      originalTitle: base.original_title || '',
      text
    });
  }

  async tmdbEpisode(key, showId, season, episode) {
    const path = `/tv/${showId}/season/${season}/episode/${episode}`;
    const base = await this.tmdb(key, path, { language: 'en-US', append_to_response: 'external_ids' });
    const show = await this.tmdb(key, `/tv/${showId}`, { language: 'en-US' });

    const text = await this.allLanguages(async (language) => {
      const ep = language === 'en-US' ? base : await this.tmdb(key, path, { language });
      const series = language === 'en-US' ? show : await this.tmdb(key, `/tv/${showId}`, { language });
      return {
        // TMDB fills untranslated episodes with "Episode 24": not a real title
        title: /^(episode|episódio|episodio)\s+\d+$/i.test(ep.name || '') ? '' : (ep.name || ''),
        showTitle: series.name || '',
        overview: ep.overview || '',
        genres: (series.genres || []).map(g => g.name),
        poster: this.image(series.poster_path, 'w342')
      };
    });

    const imdbId = (base.external_ids && base.external_ids.imdb_id) || '';

    return this.finish({
      source: 'tmdb',
      kind: 'episode',
      link: imdbId ? `https://www.imdb.com/title/${imdbId}/` : `https://www.themoviedb.org/tv/${showId}/season/${season}/episode/${episode}`,
      imdbId,
      tmdbId: base.id,
      showTmdbId: showId,
      season,
      episode,
      year: (base.air_date || show.first_air_date || '').slice(0, 4),
      date: base.air_date || '',
      runtime: base.runtime || 0,
      rating: base.vote_count ? Math.round(base.vote_average * 10) / 10 : null,
      image: this.image(base.still_path, 'w780'),
      poster: this.image(show.poster_path, 'w342'),
      originalTitle: show.original_name || '',
      text
    });
  }

  // ── IMDb (no key) ────────────────────────────────────────────────────────

  async fromImdb(imdbId) {
    let item;
    try {
      const response = await axios.get(`${config.IMDB_SUGGEST}/${imdbId}.json`, { timeout: TIMEOUT });
      item = (response.data.d || []).find(entry => entry.id === imdbId);
    } catch (error) {
      throw new Error(`IMDb could not be reached (${(error.response && error.response.status) || error.code || error.message}).`);
    }

    if (!item) throw new Error('IMDb does not know this title.');
    if (/^tv(Series|MiniSeries)$/.test(item.qid)) {
      throw new Error('This is the link of a whole series. Open the episode and paste its link.');
    }

    const picture = item.i && item.i.imageUrl ? item.i.imageUrl.replace(/\._V1_.*\.jpg$/, '._V1_SX400.jpg') : '';

    return this.finish({
      source: 'imdb',
      kind: item.qid === 'tvEpisode' ? 'episode' : 'movie',
      link: `https://www.imdb.com/title/${imdbId}/`,
      imdbId,
      year: item.y ? String(item.y) : '',
      image: '',
      poster: picture,
      text: { en: { title: item.l || '', overview: '', genres: [], cast: item.s || '' } }
    });
  }

  finish(metadata) {
    logger.info('server', 'Title details read', { source: metadata.source, kind: metadata.kind, imdbId: metadata.imdbId });
    return { ...metadata, linkedAt: Date.now() };
  }
}

module.exports = new MetadataService();
