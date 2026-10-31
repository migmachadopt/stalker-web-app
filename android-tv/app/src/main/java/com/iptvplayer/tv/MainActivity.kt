package com.iptvplayer.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject

/**
 * The web app (the server's own page, so every deploy reaches the TV too) in
 * a full-screen WebView, with videos played by [TvPlayer] over it.
 *
 * The page sees window.AndroidTV (see [Bridge]) and then plays its videos here
 * and moves the focus with the remote. Back is handed to the page first
 * (window.__tvBack), which closes what is open; then the app asks to leave.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var player: TvPlayer
    private val prefs by lazy { getSharedPreferences("app", MODE_PRIVATE) }
    private var server: String? = null
    private var leaveAsked = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.userAgentString = settings.userAgentString.replace(" Mobile", "") + " IPTVPlayerTV/${BuildConfig.VERSION_NAME}"
            webChromeClient = WebChromeClient()
            webViewClient = Client()
            addJavascriptInterface(Bridge(), "AndroidTV")
        }
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        player = TvPlayer(this, root, ::sendEvent) {
            web.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
            web.requestFocus()
        }
        setContentView(root)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        server = prefs.getString("server", null)
        if (server == null) askServer(first = true) else open()
    }

    private fun open() {
        web.loadUrl("${server!!.trimEnd('/')}/")
    }

    // ── The server ───────────────────────────────────────────────────────────

    private fun askServer(first: Boolean) {
        val field = EditText(this).apply {
            setText(server ?: BuildConfig.DEFAULT_SERVER)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSelection(text.length)
        }
        val dialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Server address")
            .setMessage("The address of the IPTV Player server, as opened in a browser.\nAt home: http://192.168.1.159 · Away: https://tv.bacalhau.cc")
            .setView(field)
            .setPositiveButton("Open", null)
            .setNegativeButton(if (first) "Exit" else "Cancel") { _, _ -> if (first) finish() }
            .setCancelable(!first)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val address = field.text.toString().trim().trimEnd('/')
                val uri = Uri.parse(address)
                if ((uri.scheme != "http" && uri.scheme != "https") || uri.host.isNullOrEmpty()) {
                    field.error = "Start with http:// or https://"
                    return@setOnClickListener
                }
                server = address
                prefs.edit().putString("server", address).apply()
                dialog.dismiss()
                open()
            }
        }
        dialog.show()
    }

    private fun sameServer(uri: Uri): Boolean {
        val base = Uri.parse(server ?: return false)
        return uri.scheme == base.scheme && uri.host == base.host && uri.port == base.port
    }

    private inner class Client : WebViewClient() {
        // Only the server's own pages open here
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = !sameServer(request.url)

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            AlertDialog.Builder(this@MainActivity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Cannot open the server")
                .setMessage("$server\n${error.description}")
                .setPositiveButton("Try again") { _, _ -> open() }
                .setNeutralButton("Change the address") { _, _ -> askServer(first = false) }
                .setNegativeButton("Exit") { _, _ -> finish() }
                .setCancelable(false)
                .show()
        }
    }

    // ── The page and the player ──────────────────────────────────────────────

    private fun sendEvent(event: JSONObject) {
        web.evaluateJavascript("window.__tvPlayerEvent && window.__tvPlayerEvent($event)", null)
    }

    private fun showPlayer(json: JSONObject) {
        web.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        player.play(json)
    }

    /** window.AndroidTV. Called on a background thread, so each call goes to the main one. */
    private inner class Bridge {
        @JavascriptInterface
        fun play(json: String) = main { showPlayer(JSONObject(json)) }

        @JavascriptInterface
        fun stop() = main { player.close() }

        @JavascriptInterface
        fun notice(text: String) = main { player.notice(text) }

        @JavascriptInterface
        fun subtitleList(session: Int, json: String) = main { player.subtitleList(session, parse(json)) }

        @JavascriptInterface
        fun setSubtitle(session: Int, json: String) = main { player.setSubtitle(session, parse(json)) }

        @JavascriptInterface
        fun changeServer() = main { askServer(first = false) }

        private fun parse(json: String) = if (json == "null") null else JSONObject(json)

        private fun main(action: () -> Unit) {
            runOnUiThread { if (sameServer(Uri.parse(web.url ?: ""))) action() }
        }
    }

    // ── The remote ───────────────────────────────────────────────────────────

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (player.isShown) return player.onKey(event) || super.dispatchKeyEvent(event)

        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) back()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // The page closes what is open, or goes home; there, Back twice leaves
    private fun back() {
        web.evaluateJavascript("window.__tvBack ? window.__tvBack() : false") { handled ->
            if (handled == "true") return@evaluateJavascript
            if (System.currentTimeMillis() - leaveAsked < 2_500) {
                finish()
            } else {
                leaveAsked = System.currentTimeMillis()
                Toast.makeText(this, "Press Back again to leave", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    // Leaving the app ends the video (the provider allows one connection)
    override fun onStop() {
        player.close()
        web.onPause()
        super.onStop()
    }

    override fun onStart() {
        super.onStart()
        web.onResume()
    }

    override fun onDestroy() {
        player.release()
        web.destroy()
        super.onDestroy()
    }
}
