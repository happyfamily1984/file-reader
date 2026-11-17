package app.readforme.twa;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 앱 화면. 배포된 웹앱을 웹뷰에 띄우고, 읽기는 {@link ReadService} 에 맡긴다.
 * 웹 쪽에서는 window.ReadForMeNative 로 아래 Bridge 의 메서드를 부른다.
 */
public class MainActivity extends Activity implements ReadService.Listener {
    private static final int REQ_FILE = 1;
    private static final int MAX_SHARED_BYTES = 40 * 1024 * 1024;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingShare = "";
    private String siteUrl, siteHost;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        siteUrl = getString(R.string.launch_url);
        siteHost = getString(R.string.host);

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.background));
        // 상태바·내비게이션바·키보드에 화면이 가리지 않게, 웹뷰를 감싼 틀에 여백을 준다.
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.background));
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                    v.setPadding(i.left, i.top, i.right, i.bottom);
                } else {
                    v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                            insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                }
                return insets;
            }
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "ReadForMeNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        ReadService.listener = this;
        try {
            ReadService.send(this, ReadService.ACTION_WARM); // 음성 엔진과 목소리 목록을 미리 준비
        } catch (RuntimeException ignored) {
            // 화면이 뜨기 전이라 시작이 거절되면, 재생을 누를 때 준비된다.
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 2);
        }

        String start = siteUrl;
        Intent intent = getIntent();
        if (!readShare(intent) && intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null
                && siteHost.equals(intent.getData().getHost())) {
            start = intent.getData().toString();
        }
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(start);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (readShare(intent)) web.evaluateJavascript("window.dispatchEvent(new Event('rfmshare'))", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (ReadService.listener == this) ReadService.listener = null;
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // 웹 화면이 쌓아 둔 기록(읽기 화면 → 메뉴 → 이전 메뉴)을 따라 한 화면씩 돌아간다.
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        // 맨 처음 화면이면 종료할지 묻는다.
        final boolean reading = ReadService.state == ReadService.PLAYING;
        android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setMessage(reading ? R.string.exit_message_reading : R.string.exit_message)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.exit, new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int which) {
                        if (ReadService.state != ReadService.IDLE) {
                            try {
                                ReadService.send(MainActivity.this, ReadService.ACTION_STOP);
                            } catch (RuntimeException ignored) {
                                // 서비스가 이미 없으면 할 일이 없다.
                            }
                        }
                        finishAndRemoveTask();
                    }
                });
        if (reading) {
            b.setNeutralButton(R.string.exit_keep_reading, new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int which) {
                    moveTaskToBack(true);
                }
            });
        }
        b.show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 설정에서 목소리를 새로 받고 돌아왔을 수 있으니 목록을 다시 읽는다.
        try {
            ReadService.send(this, ReadService.ACTION_VOICES);
        } catch (RuntimeException ignored) {
            // 서비스를 시작할 수 없는 순간이면 다음 기회에 갱신된다.
        }
    }

    // ── 다른 앱에서 공유받기 ──

    /** 공유받은 글이나 파일을 웹 쪽이 가져갈 수 있게 준비한다. */
    private boolean readShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        try {
            JSONObject o = new JSONObject();
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) {
                byte[] bytes = readAll(stream);
                o.put("name", displayName(stream));
                o.put("type", getContentResolver().getType(stream));
                o.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            } else {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text == null) return false;
                o.put("text", text.toString());
                o.put("title", intent.getStringExtra(Intent.EXTRA_SUBJECT));
            }
            pendingShare = o.toString();
            return true;
        } catch (Exception e) {
            Toast.makeText(this, R.string.share_failed, Toast.LENGTH_LONG).show();
            return false;
        }
    }

    private byte[] readAll(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_SHARED_BYTES) throw new Exception("too large");
            }
            return out.toByteArray();
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
            // 이름을 알 수 없으면 주소의 마지막 부분을 쓴다.
        }
        String last = uri.getLastPathSegment();
        return last == null ? "file" : last;
    }

    // ── 재생 서비스 → 화면 ──

    @Override
    public void onState(final String json) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript("window.__rfmState&&window.__rfmState(" + json + ")", null);
            }
        });
    }

    @Override
    public void onVoices() {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                web.evaluateJavascript("window.dispatchEvent(new Event('rfmvoices'))", null);
            }
        });
    }

    // ── 화면(웹) → 재생 서비스 ──

    private class Bridge {
        private void command(final String action) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        ReadService.send(MainActivity.this, action);
                    } catch (RuntimeException e) {
                        onState(ReadService.stateJson(null, "재생을 시작하지 못했습니다. 앱을 다시 열어 주세요."));
                    }
                }
            });
        }

        @JavascriptInterface
        public void load(String json) throws Exception {
            JSONObject o = new JSONObject(json);
            JSONArray arr = o.getJSONArray("texts");
            final List<String> list = new ArrayList<>(arr.length());
            for (int i = 0; i < arr.length(); i++) list.add(arr.getString(i));
            final String title = o.optString("title");
            final int index = o.optInt("index");
            // 재생 상태는 메인 스레드에서만 바꾼다. 웹 쪽이 바로 state() 를 읽으므로 끝날 때까지 기다린다.
            final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        ReadService.setDoc(title, list, index);
                    } finally {
                        done.countDown();
                    }
                }
            });
            done.await(3, java.util.concurrent.TimeUnit.SECONDS);
        }

        @JavascriptInterface
        public void configure(String json) throws Exception {
            JSONObject o = new JSONObject(json);
            float rate = (float) o.optDouble("rate", 1);
            String voice = o.optString("voice");
            boolean changed = rate != ReadService.rate || !voice.equals(ReadService.voiceName);
            ReadService.rate = rate;
            ReadService.voiceName = voice;
            ReadService.repeat = o.optInt("repeat", 1);
            ReadService.loopOne = o.optBoolean("loopOne");
            if (changed) command(ReadService.ACTION_CONFIG);
        }

        @JavascriptInterface public void play() { command(ReadService.ACTION_PLAY); }
        @JavascriptInterface public void pause() { command(ReadService.ACTION_PAUSE); }
        @JavascriptInterface public void stop() { command(ReadService.ACTION_STOP); }

        @JavascriptInterface
        public void seek(final int index) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        startService(new Intent(MainActivity.this, ReadService.class)
                                .setAction(ReadService.ACTION_SEEK).putExtra(ReadService.EXTRA_INDEX, index));
                    } catch (RuntimeException ignored) {
                        ReadService.index = Math.max(0, Math.min(index, Math.max(0, ReadService.texts.size() - 1)));
                    }
                }
            });
        }

        /** 기기의 음성 출력 설정을 연다: 목소리 데이터를 더 받거나 음성 엔진을 바꿀 수 있다. */
        @JavascriptInterface
        public void openVoiceSettings() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        startActivity(new Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
                        } catch (Exception ignored) {
                            Toast.makeText(MainActivity.this, R.string.voice_settings_failed, Toast.LENGTH_LONG).show();
                        }
                    }
                }
            });
        }

        @JavascriptInterface public String state() { return ReadService.stateJson(null, null); }
        @JavascriptInterface public String voices() { return ReadService.voicesJson; }

        @JavascriptInterface
        public String takeShared() {
            String s = pendingShare;
            pendingShare = "";
            return s;
        }
    }

    // ── 웹뷰 동작 ──

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (siteHost.equals(uri.getHost()) && !String.valueOf(uri.getPath()).endsWith(".apk")) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri)); // 바깥 링크는 브라우저로
            } catch (Exception ignored) {
                // 열 수 있는 앱이 없으면 무시
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            String html = "<meta name=viewport content='width=device-width,initial-scale=1'>"
                    + "<body style='font-family:sans-serif;text-align:center;padding:48px 24px;background:#f1fbf7;color:#14231d'>"
                    + "<h2>인터넷에 연결할 수 없습니다</h2><p>처음 한 번은 인터넷이 필요합니다.<br>연결한 뒤 다시 시도해 주세요.</p>"
                    + "<p><a href='" + siteUrl + "' style='display:inline-block;padding:14px 28px;border-radius:16px;background:#15936e;color:#fff;"
                    + "text-decoration:none;font-weight:bold'>다시 시도</a></p></body>";
            view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(pick, getString(R.string.pick_file)), REQ_FILE);
            } catch (Exception e) {
                fileCallback = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
        fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
        fileCallback = null;
    }
}
