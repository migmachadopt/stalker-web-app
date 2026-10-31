package com.iptvplayer.tv

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The video player over the web page: ExoPlayer, which plays what the TV can
 * (MKV, HEVC, AC3 and E-AC3 decoded by the TV or passed to the amplifier).
 *
 * The page asks for a video with play() (see nativePlayer in index.html) and
 * hears back through [emit]: the position every few seconds, the last one when
 * the video closes, a live channel that dropped, the remote asking for another
 * channel or for the next episode, and the subtitles chosen.
 *
 * Each video is a session; a video played over another one closes the first
 * with replaced = true.
 */
@androidx.annotation.OptIn(UnstableApi::class)
class TvPlayer(
    private val activity: Activity,
    root: FrameLayout,
    private val emit: (JSONObject) -> Unit,
    private val onHidden: () -> Unit
) {
    private class Source(val url: String, val hls: Boolean)
    private class Track(val url: String, val language: String, val name: String)
    private class Alternate(val source: Source, val label: String, val back: String, val onError: Boolean)
    private class Media(
        val session: Int,
        val main: Source,
        val alternate: Alternate?,
        val live: Boolean,
        val title: String,
        val subtitle: String,
        val startAt: Double,
        val next: String,
        val subtitles: Boolean
    )

    private val handler = Handler(Looper.getMainLooper())
    private val player: ExoPlayer
    private val view: PlayerView
    private val heading: LinearLayout
    private val titleView: TextView
    private val subtitleView: TextView
    private val noticeView: TextView
    private val actions: LinearLayout
    private val alternateButton: TextView
    private val subtitlesButton: TextView
    private val nextButton: TextView

    private var media: Media? = null
    private var onAlternate = false
    private var track: Track? = null
    private var trackApplied = false
    private var audioChecked = false
    private var playingSent = false
    private var failures = 0
    private var subtitleList: JSONArray? = null
    private var subtitlePending = false

    val isShown get() = media != null

    init {
        val renderers = DefaultRenderersFactory(activity).setEnableDecoderFallback(true)
        val extractors = DefaultExtractorsFactory()
            .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS)
            .setConstantBitrateSeekingEnabled(true)
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("IPTVPlayerTV/${BuildConfig.VERSION_NAME}")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(30_000)

        player = ExoPlayer.Builder(activity, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(activity, http), extractors))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        player.addListener(Listener())

        view = PlayerView(activity).apply {
            player = this@TvPlayer.player
            setBackgroundColor(Color.BLACK)
            setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowSubtitleButton(true)
            controllerShowTimeoutMs = 4_000
            isFocusable = true
            visibility = View.GONE
            setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
                val shown = visibility == View.VISIBLE
                heading.visibility = if (shown) View.VISIBLE else View.GONE
                actions.visibility = if (shown && actions.hasVisibleChild()) View.VISIBLE else View.GONE
                if (!shown) requestFocus()
            })
        }
        root.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        titleView = text(26f, Color.WHITE)
        subtitleView = text(17f, Color.parseColor("#C8CDE0"))
        heading = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(Color.parseColor("#B30E1220"))
            setPadding(dp(20), dp(12), dp(20), dp(12))
            addView(titleView)
            addView(subtitleView)
            visibility = View.GONE
        }
        root.addView(heading, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply {
            setMargins(dp(40), dp(28), dp(40), 0)
        })

        alternateButton = button { switchVersion() }
        subtitlesButton = button { chooseSubtitles() }.apply { text = "Subtitles" }
        nextButton = button { media?.let { event(it, "next") } }
        actions = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(alternateButton)
            addView(subtitlesButton)
            addView(nextButton)
            visibility = View.GONE
        }
        root.addView(actions, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
            setMargins(dp(40), dp(32), dp(40), 0)
        })

        noticeView = text(20f, Color.WHITE).apply {
            background = rounded(Color.parseColor("#CC0E1220"))
            setPadding(dp(24), dp(14), dp(24), dp(14))
            gravity = Gravity.CENTER
            visibility = View.GONE
        }
        root.addView(noticeView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    // ── Asked by the page ────────────────────────────────────────────────────

    fun play(json: JSONObject) {
        media?.let { closed(it, replaced = true) }

        val alternate = json.optJSONObject("alternate")?.let {
            Alternate(Source(it.getString("url"), it.optBoolean("hls")), it.text("label", "Other version"), it.text("back", "Original"), it.optBoolean("onError"))
        }
        val m = Media(
            session = json.getInt("session"),
            main = Source(json.getString("url"), json.optBoolean("hls")),
            alternate = alternate,
            live = json.optBoolean("live"),
            title = json.text("title"),
            subtitle = json.text("subtitle"),
            startAt = json.optDouble("startAt", 0.0).takeIf { !it.isNaN() } ?: 0.0,
            next = json.text("next"),
            subtitles = json.optBoolean("subtitles")
        )
        media = m
        onAlternate = false
        failures = 0
        subtitleList = null
        subtitlePending = false
        track = json.optJSONObject("subtitleTrack")?.let { Track(it.getString("url"), it.text("language"), "${it.text("name", "Subtitles")} · OpenSubtitles") }

        titleView.text = m.title
        subtitleView.text = m.subtitle
        subtitleView.visibility = if (m.subtitle.isEmpty()) View.GONE else View.VISIBLE
        alternateButton.text = alternate?.label ?: ""
        alternateButton.visibility = if (alternate != null) View.VISIBLE else View.GONE
        subtitlesButton.visibility = if (m.subtitles) View.VISIBLE else View.GONE
        nextButton.text = m.next
        nextButton.visibility = if (m.next.isNotEmpty()) View.VISIBLE else View.GONE
        view.setShowFastForwardButton(!m.live)
        view.setShowRewindButton(!m.live)
        notice("")

        show()
        load(if (m.live) C.TIME_UNSET else (m.startAt * 1000).toLong())
        if (m.live) flashHeading()
    }

    fun notice(text: String) {
        if (media == null) return
        noticeView.text = text
        noticeView.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    fun close() {
        val m = media ?: return
        closed(m, replaced = false)
        media = null
        handler.removeCallbacksAndMessages(null)
        player.stop()
        player.clearMediaItems()
        view.visibility = View.GONE
        view.keepScreenOn = false
        heading.visibility = View.GONE
        actions.visibility = View.GONE
        noticeView.visibility = View.GONE
        onHidden()
    }

    fun release() {
        handler.removeCallbacksAndMessages(null)
        player.release()
    }

    fun subtitleList(session: Int, json: JSONObject?) {
        val m = media ?: return
        if (m.session != session) return
        subtitlePending = false
        if (json == null || json.has("error")) return toast(json?.optString("error") ?: "Could not look for subtitles")
        val entries = json.optJSONArray("entries") ?: JSONArray()
        subtitleList = entries
        showSubtitles(entries)
    }

    fun setSubtitle(session: Int, json: JSONObject?) {
        val m = media ?: return
        if (m.session != session) return
        if (json != null && json.has("error")) return toast(json.getString("error"))
        track = json?.let { Track(it.getString("url"), it.text("language"), "${it.text("name", "Subtitles")} · OpenSubtitles") }
        load(player.currentPosition)
    }

    // ── The remote ───────────────────────────────────────────────────────────
    // Back hides the controls, then closes. On a channel Up and Down (and the
    // channel buttons) change channel; on a film Left and Right go back 10 s
    // and forward 30 s, and with the controls shown the arrows move between
    // them.

    fun onKey(event: KeyEvent): Boolean {
        val m = media ?: return false
        val code = event.keyCode
        if (code == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) {
                if (view.isControllerFullyVisible) view.hideController() else close()
            }
            return true
        }
        if (event.action != KeyEvent.ACTION_DOWN) return false

        val controls = view.isControllerFullyVisible
        if (m.live) {
            val step = when (code) {
                KeyEvent.KEYCODE_CHANNEL_UP -> 1
                KeyEvent.KEYCODE_CHANNEL_DOWN -> -1
                // (a channel's controls are all in one row: Up and Down are free)
                KeyEvent.KEYCODE_DPAD_UP -> 1
                KeyEvent.KEYCODE_DPAD_DOWN -> -1
                else -> 0
            }
            if (step != 0) {
                event(m, "zap", "step" to step)
                return true
            }
        } else if (!controls) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> return seekBy(-10_000)
                KeyEvent.KEYCODE_DPAD_RIGHT -> return seekBy(30_000)
            }
        }
        if (code == KeyEvent.KEYCODE_INFO || code == KeyEvent.KEYCODE_MENU) {
            view.showController()
            return true
        }
        return false
    }

    // ── Playing ──────────────────────────────────────────────────────────────

    private fun show() {
        view.visibility = View.VISIBLE
        view.keepScreenOn = true
        view.requestFocus()
        handler.removeCallbacks(ticker)
        handler.postDelayed(ticker, POSITION_EVERY)
    }

    private fun load(positionMs: Long) {
        val m = media ?: return
        val source = if (onAlternate) m.alternate!!.source else m.main
        val item = MediaItem.Builder().setUri(source.url)
        if (source.hls) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        track?.let {
            item.setSubtitleConfigurations(listOf(
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(it.url))
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(it.language)
                    .setLabel(it.name)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build()
            ))
        }

        trackApplied = false
        audioChecked = false
        playingSent = false
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT).build()
        if (positionMs == C.TIME_UNSET || positionMs <= 0) player.setMediaItem(item.build()) else player.setMediaItem(item.build(), positionMs)
        player.prepare()
        player.playWhenReady = true
    }

    // The other version of the video, from where this one is
    private fun switchVersion(message: String? = null) {
        val m = media ?: return
        val alternate = m.alternate ?: return
        val position = player.currentPosition
        onAlternate = !onAlternate
        alternateButton.text = if (onAlternate) alternate.back else alternate.label
        failures = 0
        message?.let { toast(it) }
        load(position)
    }

    private fun seekBy(deltaMs: Long): Boolean {
        val duration = player.duration.takeIf { it != C.TIME_UNSET } ?: Long.MAX_VALUE
        player.seekTo((player.currentPosition + deltaMs).coerceIn(0, duration))
        view.showController()
        return true
    }

    private fun flashHeading() {
        heading.visibility = View.VISIBLE
        handler.removeCallbacks(hideHeading)
        handler.postDelayed(hideHeading, 4_000)
    }

    private val hideHeading = Runnable { if (!view.isControllerFullyVisible) heading.visibility = View.GONE }

    private val ticker = object : Runnable {
        override fun run() {
            val m = media ?: return
            if (!m.live && player.isPlaying) {
                event(m, "position", "position" to player.currentPosition / 1000.0, "duration" to durationSeconds())
            }
            handler.postDelayed(this, POSITION_EVERY)
        }
    }

    private fun durationSeconds() = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 } ?: 0.0

    private fun closed(m: Media, replaced: Boolean) {
        val duration = durationSeconds()
        val position = if (player.playbackState == Player.STATE_ENDED && duration > 0) duration else player.currentPosition / 1000.0
        event(m, "closed", "replaced" to replaced, "position" to if (m.live) 0.0 else position, "duration" to duration)
    }

    private inner class Listener : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            val m = media ?: return
            if (isPlaying && !playingSent) {
                playingSent = true
                failures = 0
                if (noticeView.text.startsWith("Reconnecting")) notice("")
                event(m, "playing")
            }
        }

        override fun onPlaybackStateChanged(state: Int) {
            val m = media ?: return
            if (state != Player.STATE_ENDED) return
            when {
                m.live -> event(m, "ended")
                m.next.isNotEmpty() -> event(m, "next")
                else -> close()
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val m = media ?: return
            if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                player.seekToDefaultPosition()
                player.prepare()
                return
            }

            val decoding = error.errorCode in 3000..4999
            val alternate = m.alternate
            if (alternate != null && alternate.onError && !onAlternate) {
                switchVersion("This video cannot be played as it is. Playing the compatible version.")
                return
            }
            // The page asks for the channel again, as it does in the browser
            if (m.live) {
                event(m, "ended", "error" to (error.message ?: ""))
                return
            }
            if (!decoding && failures < MAX_FAILURES) {
                failures++
                notice("Reconnecting... ($failures/$MAX_FAILURES)")
                val at = player.currentPosition
                handler.postDelayed({ if (media === m) load(at) }, failures * 1_000L)
                return
            }
            notice(if (decoding) "This video cannot be played on this TV." else "The connection to this video was lost.")
        }

        override fun onTracksChanged(tracks: Tracks) {
            // The subtitle chosen, over any in the file
            val wanted = track
            if (wanted != null && !trackApplied) {
                val group = tracks.groups.firstOrNull { group ->
                    group.type == C.TRACK_TYPE_TEXT && (0 until group.length).any { group.getTrackFormat(it).label == wanted.name }
                }
                if (group != null) {
                    trackApplied = true
                    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
                        .build()
                }
            }

            // Sound the TV cannot play (DTS or TrueHD on some): the compatible
            // version when there is one
            val audio = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            if (audioChecked || audio.isEmpty()) return
            audioChecked = true
            if (audio.any { it.isSupported }) return
            val alternate = media?.alternate
            if (alternate != null && alternate.onError && !onAlternate) {
                switchVersion("This TV cannot play this sound. Playing the compatible version.")
            } else {
                toast("This TV cannot play the sound of this video.")
            }
        }
    }

    // ── Subtitles (OpenSubtitles, searched by the page) ──────────────────────

    private fun chooseSubtitles() {
        val m = media ?: return
        subtitleList?.let { return showSubtitles(it) }
        if (subtitlePending) return
        subtitlePending = true
        toast("Looking for subtitles...")
        event(m, "subtitleSearch")
    }

    private fun showSubtitles(entries: JSONArray) {
        val m = media ?: return
        if (entries.length() == 0) return toast("No subtitles found for this title.")
        val labels = arrayOf("Off") + (0 until entries.length()).map {
            val entry = entries.getJSONObject(it)
            "${entry.text("label")}\n${entry.text("release")}"
        }
        AlertDialog.Builder(activity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Subtitles")
            .setItems(labels) { _, which ->
                if (which == 0) {
                    event(m, "subtitle", "id" to JSONObject.NULL)
                } else {
                    val entry = entries.getJSONObject(which - 1)
                    event(m, "subtitle", "id" to entry.getString("id"), "language" to entry.text("language"))
                }
            }
            .show()
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun event(m: Media, type: String, vararg values: Pair<String, Any>) {
        val json = JSONObject().put("type", type).put("session", m.session)
        for ((name, value) in values) json.put(name, value)
        emit(json)
    }

    private fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_LONG).show()

    private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), activity.resources.displayMetrics).toInt()

    private fun rounded(color: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(14).toFloat()
    }

    private fun text(size: Float, color: Int) = TextView(activity).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color)
    }

    private fun button(onClick: () -> Unit) = text(17f, Color.WHITE).apply {
        isFocusable = true
        isClickable = true
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), rounded(Color.parseColor("#5B7CFF")))
            addState(intArrayOf(), rounded(Color.parseColor("#B30E1220")))
        }
        setPadding(dp(20), dp(10), dp(20), dp(10))
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            marginStart = dp(10)
        }
        setOnClickListener { onClick() }
    }

    private fun LinearLayout.hasVisibleChild() = (0 until childCount).any { getChildAt(it).visibility == View.VISIBLE }

    private fun JSONObject.text(name: String, fallback: String = "") =
        if (isNull(name)) fallback else optString(name, fallback).ifEmpty { fallback }

    companion object {
        private const val POSITION_EVERY = 5_000L
        private const val MAX_FAILURES = 4
    }
}
