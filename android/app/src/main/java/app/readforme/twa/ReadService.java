package app.readforme.twa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 읽기 재생 서비스. 화면이 꺼지거나 다른 앱을 쓰는 동안에도 글을 계속 읽는다.
 *
 * - 기기의 음성 엔진(TextToSpeech)으로 문장을 차례로 읽고, 반복·문장 반복을 처리한다.
 * - 읽기 시작할 때 오디오 포커스를 "잠깐 빌리는" 방식으로 얻어 다른 음악 앱이 멈추게 하고,
 *   읽기가 끝나거나 정지하면 돌려주어 그 앱이 다시 재생되게 한다.
 * - 다른 앱이 소리를 내기 시작하면(포커스를 잃으면) 읽기를 멈추고 위치를 그대로 둔다.
 * - 알림창(상단바)과 잠금 화면에 재생 조작과 위치 막대를 보여 준다.
 *
 * 읽을 글과 위치는 프로세스가 살아 있는 동안 유지되도록 static 으로 둔다.
 */
public class ReadService extends Service implements TextToSpeech.OnInitListener, AudioManager.OnAudioFocusChangeListener {
    public static final String ACTION_PLAY = "app.readforme.PLAY";
    public static final String ACTION_PAUSE = "app.readforme.PAUSE";
    public static final String ACTION_TOGGLE = "app.readforme.TOGGLE";
    public static final String ACTION_STOP = "app.readforme.STOP";
    public static final String ACTION_NEXT = "app.readforme.NEXT";
    public static final String ACTION_PREV = "app.readforme.PREV";
    public static final String ACTION_SEEK = "app.readforme.SEEK";
    public static final String ACTION_CONFIG = "app.readforme.CONFIG";
    public static final String ACTION_WARM = "app.readforme.WARM";
    public static final String ACTION_VOICES = "app.readforme.VOICES";
    /** 받은 글 기다리기를 켜거나 끈다 (watchId 를 바꾼 뒤 보낸다). */
    public static final String ACTION_WATCH = "app.readforme.WATCH";
    public static final String ACTION_WATCH_OFF = "app.readforme.WATCH_OFF";
    public static final String ACTION_POLL = "app.readforme.POLL";
    public static final String EXTRA_INDEX = "index";

    static final int IDLE = 0, PLAYING = 1, PAUSED = 2;
    private static final String CHANNEL = "reading";
    private static final int NOTIFICATION_ID = 1;
    private static final int MAX_PART = 3000;
    /** 온라인 AI 목소리: voiceName 이 "cloud:<목소리 이름>" 이면 서버(/api/tts)에서 음성을 받아 재생한다. */
    static final String CLOUD_PREFIX = "cloud:";
    private static final int CLOUD_PART = 300;
    private static final long CLOUD_RETRY_MS = 60000;
    private static final java.util.regex.Pattern SPEAKABLE = java.util.regex.Pattern.compile("[\\p{L}\\p{N}]");
    static CloudAudio.Factory cloudFactory = new CloudAudio.Factory() {
        @Override public CloudAudio create(Context context) { return new CloudAudio.Media(); }
    };
    static long cloudDownUntil = 0;

    // ── 받은 글 기다리기: 새 글이 도착하면 화면이 꺼져 있어도 바로 읽는다 ──
    private static final long POLL_MS = 30000;
    /** 기다릴 수신함 id. 비어 있으면 기다리지 않는다. */
    static String watchId = "";
    /** 이미 본 글 이름들. null 이면 다음 확인 때 "지금 있는 글"을 기준으로 삼는다. */
    static java.util.Set<String> known = null;
    /** 도착했지만 아직 읽지 않은 글 [이름, 제목]. 읽는 중이면 끝난 뒤 이어서 읽는다. */
    static final java.util.ArrayDeque<String[]> arrivals = new java.util.ArrayDeque<>();
    /** 앱이 스스로 읽은 글 이름들 (화면에서 "읽음"으로 표시하는 데 쓴다). */
    static final java.util.LinkedHashSet<String> autoPlayed = new java.util.LinkedHashSet<>();
    /** 지금 실린 글이 받은 글이면 그 이름, 문단 시작 표시. 화면이 실은 글이면 null. */
    /** 자동으로 읽기 시작한 새 글은 반복 설정과 상관없이 한 번만 읽는다. */
    static boolean playOnce = false;
    static String docItem = null;
    static List<Boolean> paragraphStart = null;
    static Fetcher fetcher = new Fetcher() {
        @Override public String get(String url) throws Exception {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            try {
                c.setConnectTimeout(10000);
                c.setReadTimeout(15000);
                if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                try (java.io.InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[16384];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
                return out.toString("UTF-8");
            } finally {
                c.disconnect();
            }
        }
    };
    static java.util.concurrent.Executor network = java.util.concurrent.Executors.newSingleThreadExecutor();

    /** 화면(웹뷰)에 상태를 알리는 통로. */
    public interface Listener {
        void onState(String json);
        void onVoices();
        /** 앱이 스스로 새 글을 실었다 (받은 글 자동 읽기). 화면이 그 글을 가져가 보여 준다. */
        void onDoc();
    }

    /** 서버에서 글자를 받아 오는 통로 (시험에서는 가짜로 바꾼다). */
    interface Fetcher {
        String get(String url) throws Exception;
    }

    // ── 프로세스 전체에서 유지되는 읽기 상태 ──
    static Listener listener;
    static ReadService instance;
    static List<String> texts = new ArrayList<>();
    static String title = "";
    static int index = 0, round = 1, state = IDLE;
    static int repeat = 1;
    static boolean loopOne = false;
    static float rate = 1f;
    static String voiceName = "";
    static String voicesJson = "[]";

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ttsReady, speakWhenReady, foreground, noisyRegistered, resumeOnGain, hasFocus;
    private int gen;
    private List<String> parts = new ArrayList<>();
    private int part;
    private AudioManager audio;
    private AudioFocusRequest focusRequest;
    private MediaSessionCompat session;
    private PowerManager.WakeLock wakeLock;
    private Bitmap art;
    private CloudAudio cloud;
    private String ttsUrl, inboxUrl;
    private PowerManager.WakeLock watchLock;
    private boolean polling, fetchingArrival;
    private final Runnable pollTick = new Runnable() {
        @Override public void run() { poll(); }
    };

    // ── 화면에서 부르는 정적 진입점 ──

    /** 새 글을 싣는다(메인 스레드). 같은 글을 이미 읽는 중이면 위치와 상태를 유지한다. */
    static void setDoc(String newTitle, List<String> newTexts, int newIndex) {
        boolean same = state != IDLE && newTexts.equals(texts);
        title = newTitle;
        if (same) return;
        if (instance != null && state != IDLE) instance.finish(null, false); // 읽던 글은 끝낸다
        state = IDLE;
        texts = newTexts;
        index = Math.max(0, Math.min(newIndex, Math.max(0, newTexts.size() - 1)));
        round = 1;
        docItem = null;
        paragraphStart = null;
        playOnce = false;
    }

    /** 지금 실린 글 전체. 화면이 닫혀 있는 동안 앱이 스스로 실은 글을 화면이 가져갈 때 쓴다. */
    static String currentJson() {
        try {
            JSONObject o = new JSONObject(stateJson(null, null));
            o.put("title", title);
            o.put("texts", new JSONArray(texts));
            if (paragraphStart != null) o.put("np", new JSONArray(paragraphStart));
            if (docItem != null) o.put("item", docItem);
            o.put("played", new JSONArray(autoPlayed));
            o.put("watching", !watchId.isEmpty());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    static String stateJson(String event, String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("state", state == PLAYING ? "playing" : state == PAUSED ? "paused" : "idle");
            o.put("i", index);
            o.put("round", round);
            o.put("n", texts.size());
            if (event != null) o.put("ev", event);
            if (error != null) o.put("error", error);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    static void send(Context context, String action) {
        context.startService(new Intent(context, ReadService.class).setAction(action));
    }

    // ── 서비스 수명 ──

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        audio = (AudioManager) getSystemService(AUDIO_SERVICE);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "readforme:reading");
        wakeLock.setReferenceCounted(false);
        art = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
        tts = new TextToSpeech(getApplicationContext(), this);
        cloud = cloudFactory.create(this);
        ttsUrl = getString(R.string.launch_url) + "api/tts";
        inboxUrl = getString(R.string.launch_url) + "api/inbox";
        watchLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "readforme:watching");
        watchLock.setReferenceCounted(false);

        session = new MediaSessionCompat(this, "ReadForMe");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { play(); }
            @Override public void onPause() { pause(false); }
            @Override public void onStop() { stop(); }
            @Override public void onSkipToNext() { seek(index + 1); }
            @Override public void onSkipToPrevious() { seek(index - 1); }
            @Override public void onSeekTo(long pos) { seek((int) (pos / 1000)); }
        });

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_reading), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return START_NOT_STICKY;
        try {
            handle(action, intent);
        } catch (RuntimeException e) {
            // 예기치 못한 문제로 앱이 꺼지지 않게 하고, 화면에 알린다.
            android.util.Log.e("ReadForMe", "command failed: " + action, e);
            fail("재생 중 문제가 생겼습니다. 다시 시도해 주세요.");
        }
        return START_NOT_STICKY;
    }

    private void handle(String action, Intent intent) {
        switch (action) {
            case ACTION_PLAY: play(); break;
            case ACTION_PAUSE: pause(false); break;
            case ACTION_TOGGLE: if (state == PLAYING) pause(false); else play(); break;
            case ACTION_STOP: stop(); break;
            case ACTION_NEXT: seek(index + 1); break;
            case ACTION_PREV: seek(index - 1); break;
            case ACTION_SEEK: seek(intent.getIntExtra(EXTRA_INDEX, index)); break;
            case ACTION_CONFIG: applyVoiceAndRate(); if (state == PLAYING) speakCurrent(); break;
            case ACTION_VOICES: if (ttsReady) publishVoices(); break;
            case ACTION_WATCH: applyWatch(); break;
            case ACTION_WATCH_OFF:
                watchId = "";
                getSharedPreferences("watch", MODE_PRIVATE).edit().remove("id").apply();
                applyWatch();
                if (listener != null) listener.onDoc();
                break;
            case ACTION_POLL: poll(); break;
            default: break; // ACTION_WARM: 음성 엔진만 미리 준비
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        gen++;
        if (state == PLAYING) state = PAUSED;
        releaseFocus();
        unregisterNoisy();
        if (wakeLock.isHeld()) wakeLock.release();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        cloud.release();
        main.removeCallbacks(pollTick);
        if (watchLock.isHeld()) watchLock.release();
        session.release();
        emit(null, null);
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 최근 앱 목록에서 앱을 밀어 없앴을 때: 읽는 중이 아니면 서비스도 끝낸다.
        if (state != PLAYING && watchId.isEmpty()) {
            stopForegroundCompat();
            stopSelf();
        }
    }

    // ── 음성 엔진 ──

    @Override
    public void onInit(int status) {
        if (status != TextToSpeech.SUCCESS) {
            if (speakWhenReady) fail("음성 엔진을 시작하지 못했습니다. 기기 설정에서 음성 출력(TTS)을 확인해 주세요.");
            return;
        }
        ttsReady = true;
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(final String id) {
                main.post(new Runnable() { @Override public void run() { onPartDone(id); } });
            }
            @Override public void onError(final String id) {
                main.post(new Runnable() { @Override public void run() {
                    if (id.equals(currentId()) && state == PLAYING) fail("음성 재생 중 문제가 생겼습니다. 다른 목소리를 골라 보세요.");
                } });
            }
        });
        publishVoices();
        applyVoiceAndRate();
        if (speakWhenReady) {
            speakWhenReady = false;
            if (state == PLAYING) speakCurrent();
        }
    }

    private void publishVoices() {
        JSONArray arr = new JSONArray();
        try {
            if (tts.getVoices() != null) {
                for (Voice v : tts.getVoices()) {
                    if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", v.getName());
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("voiceURI", v.getName());
                    o.put("online", v.isNetworkConnectionRequired()); // 인터넷이 필요한 목소리 (대체로 더 자연스럽다)
                    o.put("quality", v.getQuality());
                    arr.put(o);
                }
            }
        } catch (Exception ignored) {
            // 일부 음성 엔진은 목소리 목록을 주지 않는다 → 기기 기본 목소리 사용
        }
        voicesJson = arr.toString();
        if (listener != null) listener.onVoices();
    }

    private void applyVoiceAndRate() {
        if (!ttsReady) return;
        tts.setSpeechRate(rate);
        boolean set = false;
        try {
            if (!voiceName.isEmpty() && !voiceName.startsWith(CLOUD_PREFIX) && tts.getVoices() != null) {
                for (Voice v : tts.getVoices()) {
                    if (v.getName().equals(voiceName)) {
                        set = tts.setVoice(v) == TextToSpeech.SUCCESS;
                        break;
                    }
                }
            }
        } catch (Exception ignored) {
            // 아래에서 한국어 기본 목소리로 대체
        }
        if (!set) tts.setLanguage(Locale.KOREAN);
    }

    private String currentId() {
        return gen + ":" + part;
    }

    private boolean useCloud() {
        return voiceName.startsWith(CLOUD_PREFIX) && android.os.SystemClock.elapsedRealtime() >= cloudDownUntil;
    }

    private String cloudUrl(String text) {
        return ttsUrl + "?voice=" + android.net.Uri.encode(voiceName.substring(CLOUD_PREFIX.length())) + "&text=" + android.net.Uri.encode(text);
    }

    /** 현재 문장을 처음부터 읽는다. 아주 긴 문장은 나눠서 이어 읽는다. */
    private void speakCurrent() {
        gen++;
        cloud.stop();
        if (texts.isEmpty()) return;
        if (useCloud()) {
            parts = split(texts.get(index), CLOUD_PART);
            part = 0;
            speakPart();
            return;
        }
        if (!ttsReady) {
            speakWhenReady = true;
            return;
        }
        tts.stop();
        parts = split(texts.get(index), MAX_PART);
        part = 0;
        speakPart();
    }

    private void speakPart() {
        if (part >= parts.size()) {
            advance();
            return;
        }
        final String id = currentId();
        if (useCloud()) {
            String text = parts.get(part);
            if (!SPEAKABLE.matcher(text).find()) { // 기호뿐인 조각은 건너뛴다
                main.post(new Runnable() { @Override public void run() { onPartDone(id); } });
                return;
            }
            cloud.play(cloudUrl(text), rate,
                    new Runnable() { @Override public void run() { onPartDone(id); } },
                    new Runnable() { @Override public void run() { onCloudError(id); } });
            String upcoming = upcomingPart();
            if (upcoming != null) cloud.preload(cloudUrl(upcoming));
            return;
        }
        if (!ttsReady) { // 온라인 목소리로 읽다가 기기 목소리로 넘어온 직후
            speakWhenReady = true;
            return;
        }
        Bundle params = new Bundle();
        params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
        if (tts.speak(parts.get(part), TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) {
            fail("음성 엔진이 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.");
        }
    }

    /** 다음에 읽을 조각 (미리 받아 두기용). 기호뿐인 문장은 건너뛰고 찾는다. */
    private String upcomingPart() {
        if (part + 1 < parts.size()) return parts.get(part + 1);
        if (loopOne && !playOnce) return parts.isEmpty() ? null : parts.get(0);
        int nextIndex = index;
        for (int tries = 0; tries < 5; tries++) {
            nextIndex++;
            if (nextIndex >= texts.size()) {
                if (playOnce || (repeat != 0 && round >= repeat)) return null;
                nextIndex = 0;
            }
            List<String> p = split(texts.get(nextIndex), CLOUD_PART);
            if (!p.isEmpty() && SPEAKABLE.matcher(p.get(0)).find()) return p.get(0);
        }
        return null;
    }

    /** 온라인 목소리를 받지 못함 → 한동안 기기 목소리로 대신 읽는다. */
    private void onCloudError(String id) {
        if (state != PLAYING || !id.equals(currentId())) return;
        cloudDownUntil = android.os.SystemClock.elapsedRealtime() + CLOUD_RETRY_MS;
        emit(null, "온라인 AI 목소리에 연결하지 못해, 잠시 폰 목소리로 읽습니다.");
        applyVoiceAndRate();
        speakCurrent();
    }

    private void onPartDone(String id) {
        if (state != PLAYING || !id.equals(currentId())) return;
        part++;
        speakPart();
    }

    static List<String> split(String text) {
        return split(text, MAX_PART);
    }

    static List<String> split(String text, int max) {
        List<String> out = new ArrayList<>();
        String rest = text == null ? "" : text.trim();
        while (rest.length() > max) {
            int cut = rest.lastIndexOf(' ', max);
            if (cut < max / 2) cut = max;
            out.add(rest.substring(0, cut));
            rest = rest.substring(cut).trim();
        }
        if (!rest.isEmpty()) out.add(rest);
        return out;
    }

    // ── 재생 조작 ──

    private void play() {
        if (texts.isEmpty()) {
            stopSelf();
            return;
        }
        if (!requestFocus()) {
            state = PAUSED;
            fail("지금은 소리를 낼 수 없습니다 (통화 중일 수 있습니다).");
            return;
        }
        state = PLAYING;
        resumeOnGain = false;
        registerNoisy();
        if (!wakeLock.isHeld()) wakeLock.acquire();
        session.setActive(true);
        showNotification();
        emit(null, null);
        speakCurrent();
    }

    /** 멈춘다. 위치는 그대로 두어 다음에 이어 읽는다. */
    private void pause(boolean keepForResume) {
        if (state != PLAYING) return;
        gen++;
        speakWhenReady = false;
        if (ttsReady) tts.stop();
        cloud.stop();
        state = PAUSED;
        resumeOnGain = keepForResume;
        if (wakeLock.isHeld()) wakeLock.release();
        unregisterNoisy();
        showNotification();
        emit(null, null);
    }

    private void stop() {
        finish(null, true);
    }

    /** 읽기를 끝낸다: 오디오 포커스를 돌려주어 멈춰 있던 다른 앱이 다시 재생되게 한다. */
    private void finish(String event, boolean stopService) {
        gen++;
        speakWhenReady = false;
        if (ttsReady) tts.stop();
        cloud.stop();
        state = IDLE;
        index = 0;
        round = 1;
        resumeOnGain = false;
        releaseFocus();
        unregisterNoisy();
        if (wakeLock.isHeld()) wakeLock.release();
        session.setActive(false);
        if (watchId.isEmpty()) stopForegroundCompat();
        else showWaitingNotification(); // 계속 새 글을 기다린다
        emit(event, null);
        if (stopService && watchId.isEmpty()) stopSelf();
        else if (stopService) main.post(new Runnable() { @Override public void run() { playNextArrival(); } });
    }

    // ── 받은 글 기다리기 ──

    /** watchId 에 맞춰 기다리기를 시작하거나 끝낸다. */
    private void applyWatch() {
        main.removeCallbacks(pollTick);
        if (watchId.isEmpty()) {
            known = null;
            arrivals.clear();
            if (watchLock.isHeld()) watchLock.release();
            if (state == IDLE) {
                stopForegroundCompat();
                stopSelf();
            }
            return;
        }
        // 화면이 꺼져도 30초마다 확인할 수 있게 CPU 를 깨워 둔다.
        if (!watchLock.isHeld()) watchLock.acquire();
        if (state == IDLE) showWaitingNotification();
        poll();
    }

    /** 수신함을 확인한다. 새로 도착한 글이 있으면 읽을 차례에 넣는다. */
    private void poll() {
        main.removeCallbacks(pollTick);
        if (watchId.isEmpty()) return;
        main.postDelayed(pollTick, POLL_MS);
        if (polling) return;
        polling = true;
        final String id = watchId;
        network.execute(new Runnable() { @Override public void run() {
            String body = null;
            try {
                body = fetcher.get(inboxUrl + "?id=" + android.net.Uri.encode(id));
            } catch (Exception ignored) {
                // 인터넷이 잠깐 안 되면 다음 차례에 다시 확인한다.
            }
            final String result = body;
            main.post(new Runnable() { @Override public void run() {
                polling = false;
                if (result != null && id.equals(watchId)) onInboxList(result);
            } });
        } });
    }

    private void onInboxList(String json) {
        List<String[]> items = new ArrayList<>();
        try {
            JSONArray arr = new JSONObject(json).getJSONArray("items"); // 최신순
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                items.add(new String[]{o.getString("item"), o.optString("title")});
            }
        } catch (Exception e) {
            return;
        }
        if (known == null) { // 기다리기를 켠 시점에 이미 있던 글은 읽지 않는다
            known = new java.util.HashSet<>();
            for (String[] it : items) known.add(it[0]);
            return;
        }
        for (int i = items.size() - 1; i >= 0; i--) { // 먼저 도착한 것부터
            if (known.add(items.get(i)[0])) arrivals.add(items.get(i));
        }
        playNextArrival();
    }

    /** 읽는 중이 아니면, 도착해 있는 다음 글을 받아 와 읽기 시작한다. */
    private void playNextArrival() {
        if (state == PLAYING || fetchingArrival || arrivals.isEmpty() || watchId.isEmpty()) return;
        final String[] item = arrivals.poll();
        final String id = watchId;
        fetchingArrival = true;
        network.execute(new Runnable() { @Override public void run() {
            String body = null;
            try {
                body = fetcher.get(inboxUrl + "?id=" + android.net.Uri.encode(id) + "&item=" + android.net.Uri.encode(item[0]));
            } catch (Exception ignored) {
                // 받지 못한 글은 건너뛴다 (화면의 받은 글 목록에는 그대로 남아 있다).
            }
            final String result = body;
            main.post(new Runnable() { @Override public void run() {
                fetchingArrival = false;
                if (result != null && id.equals(watchId) && state != PLAYING) startArrival(item, result);
                else if (result == null) playNextArrival();
            } });
        } });
    }

    private void startArrival(String[] item, String json) {
        InboxText.Doc doc;
        String docTitle;
        try {
            JSONObject o = new JSONObject(json);
            docTitle = o.optString("title", item[1]);
            doc = InboxText.toDoc(o.getString("text"));
        } catch (Exception e) {
            playNextArrival();
            return;
        }
        if (doc.texts.isEmpty()) {
            playNextArrival();
            return;
        }
        setDoc(docTitle, doc.texts, 0);
        docItem = item[0];
        paragraphStart = doc.paragraphStart;
        playOnce = true;
        autoPlayed.add(item[0]);
        while (autoPlayed.size() > 50) autoPlayed.remove(autoPlayed.iterator().next());
        play();
        if (listener != null) listener.onDoc();
    }

    private void showWaitingNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_reading)
                .setContentTitle(getString(R.string.waiting_title))
                .setContentText(getString(R.string.waiting_text))
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .addAction(R.drawable.ic_stop, getString(R.string.waiting_stop), action(ACTION_WATCH_OFF, 6))
                .build();
        post(n);
    }

    /** 알림을 띄운다. 처음이면 포그라운드 서비스로 올린다. */
    private void post(Notification n) {
        if (!foreground) {
            try {
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                else startForeground(NOTIFICATION_ID, n);
                foreground = true;
            } catch (RuntimeException e) {
                // 화면 밖에서 시작이 막힌 드문 경우: 알림만 띄우고 계속한다.
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, n);
            }
        } else {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, n);
        }
    }

    private void seek(int to) {
        if (texts.isEmpty()) return;
        index = Math.max(0, Math.min(to, texts.size() - 1));
        if (state == PLAYING) speakCurrent();
        if (state != IDLE) showNotification();
        emit(null, null);
    }

    private void advance() {
        if (!loopOne || playOnce) {
            if (index < texts.size() - 1) index++;
            else if (!playOnce && (repeat == 0 || round < repeat)) {
                round++;
                index = 0;
            } else {
                finish("end", true);
                return;
            }
        }
        showNotification();
        emit(null, null);
        speakCurrent();
    }

    private void fail(String message) {
        if (state == PLAYING) {
            gen++;
            if (ttsReady) tts.stop();
        cloud.stop();
            state = PAUSED;
            if (wakeLock.isHeld()) wakeLock.release();
        }
        if (foreground) showNotification();
        emit(null, message);
    }

    private void emit(String event, String error) {
        if (listener != null) listener.onState(stateJson(event, error));
    }

    // ── 오디오 포커스: 다른 앱과 소리 주고받기 ──

    private boolean requestFocus() {
        if (hasFocus) return true;
        int result;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .setOnAudioFocusChangeListener(this, main)
                        .build();
            }
            result = audio.requestAudioFocus(focusRequest);
        } else {
            result = audio.requestAudioFocus(this, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
        hasFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return hasFocus;
    }

    private void releaseFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest != null) audio.abandonAudioFocusRequest(focusRequest);
        } else {
            audio.abandonAudioFocus(this);
        }
        hasFocus = false;
    }

    @Override
    public void onAudioFocusChange(int change) {
        if (change == AudioManager.AUDIOFOCUS_LOSS) {
            // 다른 음악·영상 앱이 재생을 시작함 → 멈추고, 재생 버튼을 누를 때까지 기다린다.
            hasFocus = false;
            pause(false);
            resumeOnGain = false;
        } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            // 전화·길 안내·알림음처럼 잠깐 끼어드는 소리 → 끝나면 이어서 읽는다.
            hasFocus = false;
            if (state == PLAYING) pause(true);
        } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
            hasFocus = true;
            if (state == PAUSED && resumeOnGain) play();
        }
    }

    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            pause(false); // 이어폰이 빠지면 스피커로 새어 나가지 않게 멈춘다.
        }
    };

    private void registerNoisy() {
        if (noisyRegistered) return;
        try {
            androidx.core.content.ContextCompat.registerReceiver(this, noisy,
                    new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
            noisyRegistered = true;
        } catch (RuntimeException ignored) {
            // 등록하지 못해도 읽기는 계속한다 (이어폰이 빠질 때 자동으로 멈추지 않을 뿐).
        }
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        unregisterReceiver(noisy);
        noisyRegistered = false;
    }

    // ── 알림창 · 잠금 화면 조작 ──

    private PendingIntent action(String action, int code) {
        return PendingIntent.getService(this, code, new Intent(this, ReadService.class).setAction(action),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showNotification() {
        boolean playing = state == PLAYING;
        String sentence = texts.isEmpty() ? "" : texts.get(index);
        if (sentence.length() > 200) sentence = sentence.substring(0, 200);
        String heading = title.isEmpty() ? getString(R.string.app_name) : title;

        // 위치 막대: 문장 하나를 1초로 쳐서 "몇 번째 문장인지"를 나타낸다. 막대를 끌면 그 문장으로 옮겨 간다.
        session.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, heading)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, sentence)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, texts.size() * 1000L)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
                .build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_STOP | PlaybackStateCompat.ACTION_SEEK_TO)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED, index * 1000L, 0f)
                .build());

        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_reading)
                .setLargeIcon(art)
                .setContentTitle(heading)
                .setContentText(sentence)
                .setSubText((index + 1) + " / " + texts.size())
                .setContentIntent(open)
                .setDeleteIntent(action(ACTION_STOP, 5))
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(playing)
                .addAction(R.drawable.ic_prev, getString(R.string.action_prev), action(ACTION_PREV, 1))
                .addAction(playing ? R.drawable.ic_pause : R.drawable.ic_play,
                        getString(playing ? R.string.action_pause : R.string.action_play), action(ACTION_TOGGLE, 2))
                .addAction(R.drawable.ic_next, getString(R.string.action_next), action(ACTION_NEXT, 3))
                .addAction(R.drawable.ic_stop, getString(R.string.action_stop), action(ACTION_STOP, 4))
                .setStyle(new MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
                .build();

        post(n);
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(NOTIFICATION_ID);
        foreground = false;
    }
}
