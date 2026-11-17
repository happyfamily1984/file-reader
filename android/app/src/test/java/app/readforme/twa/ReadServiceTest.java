package app.readforme.twa;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAudioManager;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** 기기 없이 재생 서비스의 흐름(읽기, 반복, 오디오 포커스, 알림)을 확인한다. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class ReadServiceTest {
    private ServiceController<ReadService> controller;
    private ReadService service;
    private final List<String> states = new ArrayList<>();
    private Context context;

    /** 가짜 온라인 재생기: 받은 주소를 기록하고, 시키는 대로 끝내거나 실패한다. */
    static class FakeCloud implements CloudAudio {
        final List<String> played = new ArrayList<>(), preloaded = new ArrayList<>();
        Runnable done, error;
        boolean auto = true, broken = false;
        int stops;
        @Override public void play(String url, float speed, Runnable onDone, Runnable onError) {
            played.add(java.net.URLDecoder.decode(url.substring(url.indexOf("?") + 1)) + "@" + speed);
            done = onDone;
            error = onError;
            if (broken) new android.os.Handler(Looper.getMainLooper()).post(onError);
            else if (auto) new android.os.Handler(Looper.getMainLooper()).post(onDone);
        }
        @Override public void preload(String url) { preloaded.add(java.net.URLDecoder.decode(url.substring(url.indexOf("&text=") + 6))); }
        @Override public void stop() { stops++; }
        @Override public void release() { }
    }
    private FakeCloud cloud;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        ReadService.state = ReadService.IDLE;
        ReadService.texts = new ArrayList<>();
        ReadService.repeat = 1;
        ReadService.loopOne = false;
        ReadService.rate = 1f;
        ReadService.voiceName = "";
        ReadService.cloudDownUntil = 0;
        cloud = new FakeCloud();
        ReadService.cloudFactory = new CloudAudio.Factory() {
            @Override public CloudAudio create(Context c) { return cloud; }
        };
        ReadService.listener = new ReadService.Listener() {
            @Override public void onState(String json) { states.add(json); }
            @Override public void onVoices() { }
        };
        controller = Robolectric.buildService(ReadService.class).create();
        service = controller.get();
        // 실제 기기에서는 음성 엔진이 준비되면 시스템이 알려 준다. 시험에서는 직접 알린다.
        shadowOf(serviceTts()).getOnInitListener().onInit(android.speech.tts.TextToSpeech.SUCCESS);
        shadowOf(Looper.getMainLooper()).idle();
    }

    @After
    public void tearDown() {
        ReadService.listener = null;
    }

    private void command(String action) {
        service.onStartCommand(new Intent(context, ReadService.class).setAction(action), 0, 1);
    }

    private ShadowAudioManager audio() {
        return shadowOf((AudioManager) context.getSystemService(Context.AUDIO_SERVICE));
    }

    private boolean hasNotification() {
        return shadowOf((NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE)).getNotification(1) != null
                || shadowOf(service).getLastForegroundNotification() != null && !shadowOf(service).isForegroundStopped();
    }

    @Test
    public void readsEverySentenceThenFinishesAndGivesFocusBack() {
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘.", "셋."), 0);
        command(ReadService.ACTION_PLAY);
        assertEquals(ReadService.PLAYING, ReadService.state);
        assertNotNull("읽는 동안 포커스를 요청해야 한다", audio().getLastAudioFocusRequest());
        assertEquals(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT, audio().getLastAudioFocusRequest().durationHint);
        assertTrue(hasNotification());

        shadowOf(Looper.getMainLooper()).idle(); // 문장이 차례로 끝난다
        assertEquals(Arrays.asList("하나.", "둘.", "셋."), shadowOf(serviceTts()).getSpokenTextList());
        assertEquals(ReadService.IDLE, ReadService.state);
        assertEquals(0, ReadService.index);
        assertTrue(states.get(states.size() - 1).contains("\"ev\":\"end\""));
        assertNotNull("끝나면 포커스를 돌려줘야 한다", audio().getLastAbandonedAudioFocusRequest());
        assertTrue(shadowOf(service).isForegroundStopped());
    }

    @Test
    public void repeatsWholeText() {
        ReadService.repeat = 2;
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘."), 0);
        command(ReadService.ACTION_PLAY);
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(Arrays.asList("하나.", "둘.", "하나.", "둘."), shadowOf(serviceTts()).getSpokenTextList());
        assertEquals(ReadService.IDLE, ReadService.state);
    }

    @Test
    public void anotherAppPlayingPausesAndKeepsPosition() {
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘.", "셋."), 1);
        command(ReadService.ACTION_PLAY);
        service.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS); // 다른 음악 앱이 재생 시작
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(ReadService.PAUSED, ReadService.state);
        assertEquals(1, ReadService.index);

        service.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); // 포커스가 돌아와도 저절로 다시 읽지 않는다
        assertEquals(ReadService.PAUSED, ReadService.state);

        command(ReadService.ACTION_PLAY); // 재생을 누르면 그 자리부터
        assertEquals(ReadService.PLAYING, ReadService.state);
        assertEquals(1, ReadService.index);
        shadowOf(Looper.getMainLooper()).idle();
        List<String> spoken = shadowOf(serviceTts()).getSpokenTextList();
        assertEquals("셋.", spoken.get(spoken.size() - 1));
        assertFalse(spoken.contains("하나."));
    }

    @Test
    public void shortInterruptionResumesAutomatically() {
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘."), 0);
        command(ReadService.ACTION_PLAY);
        service.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT); // 전화·알림음
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(ReadService.PAUSED, ReadService.state);
        service.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN);
        assertEquals(ReadService.PLAYING, ReadService.state);
    }

    @Test
    public void notificationControlsMoveBetweenSentences() {
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘.", "셋."), 0);
        command(ReadService.ACTION_PLAY);
        command(ReadService.ACTION_PAUSE);
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(ReadService.PAUSED, ReadService.state);
        assertTrue("멈춰 있어도 알림은 남는다", hasNotification());
        command(ReadService.ACTION_NEXT);
        assertEquals(1, ReadService.index);
        command(ReadService.ACTION_PREV);
        command(ReadService.ACTION_PREV);
        assertEquals(0, ReadService.index);
        service.onStartCommand(new Intent(context, ReadService.class).setAction(ReadService.ACTION_SEEK).putExtra(ReadService.EXTRA_INDEX, 2), 0, 1);
        assertEquals(2, ReadService.index);
        command(ReadService.ACTION_STOP);
        assertEquals(ReadService.IDLE, ReadService.state);
        assertEquals(0, ReadService.index);
    }

    @Test
    public void sameTextKeepsPositionButNewTextReplacesIt() {
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘.", "셋."), 0);
        command(ReadService.ACTION_PLAY);
        command(ReadService.ACTION_NEXT);
        command(ReadService.ACTION_PAUSE);
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘.", "셋."), 0); // 앱을 다시 열어 같은 글을 실었을 때
        assertEquals(1, ReadService.index);
        assertEquals(ReadService.PAUSED, ReadService.state);
        ReadService.setDoc("다른 글", Arrays.asList("가.", "나.", "다."), 2);
        assertEquals(ReadService.IDLE, ReadService.state);
        assertEquals(2, ReadService.index);
    }

    @Test
    public void longTextIsSplit() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 2000; i++) sb.append("가나다라 ");
        List<String> parts = ReadService.split(sb.toString());
        assertTrue(parts.size() >= 3);
        for (String p : parts) assertTrue(p.length() <= 3000);
    }

    @Test
    public void mainScreenStarts() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertNotNull(activity);
    }

    @Test
    public void onlineVoiceReadsThroughServerAndPreloadsNext() {
        ReadService.voiceName = "cloud:ko-KR-SunHiNeural";
        ReadService.rate = 1.5f;
        ReadService.setDoc("제목", Arrays.asList("하나.", "...", "둘 & 셋?"), 0);
        command(ReadService.ACTION_PLAY);
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(Arrays.asList("voice=ko-KR-SunHiNeural&text=하나.@1.5", "voice=ko-KR-SunHiNeural&text=둘 & 셋?@1.5"), cloud.played);
        assertTrue("기기 목소리는 쓰지 않는다", shadowOf(serviceTts()).getSpokenTextList().isEmpty());
        assertEquals("다음 문장을 미리 받는다", "둘 & 셋?", cloud.preloaded.get(cloud.preloaded.size() - 1));
        assertEquals(ReadService.IDLE, ReadService.state);
    }

    @Test
    public void onlineVoiceFailureFallsBackToDeviceVoice() {
        ReadService.voiceName = "cloud:ko-KR-InJoonNeural";
        cloud.broken = true;
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘."), 0);
        command(ReadService.ACTION_PLAY);
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals("한 번만 시도하고 한동안 기기 목소리를 쓴다", 1, cloud.played.size());
        assertEquals(Arrays.asList("하나.", "둘."), shadowOf(serviceTts()).getSpokenTextList());
        boolean told = false;
        for (String st : states) told |= st.contains("폰 목소리로 읽습니다");
        assertTrue("화면에 알린다", told);
        assertEquals(ReadService.IDLE, ReadService.state);
    }

    @Test
    public void pausingOnlineVoiceStopsAudioAndKeepsPosition() {
        ReadService.voiceName = "cloud:ko-KR-SunHiNeural";
        cloud.auto = false;
        ReadService.setDoc("제목", Arrays.asList("하나.", "둘."), 0);
        command(ReadService.ACTION_PLAY);
        cloud.done.run(); // 첫 문장 끝
        assertEquals(1, ReadService.index);
        int before = cloud.stops;
        service.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
        assertEquals(ReadService.PAUSED, ReadService.state);
        assertTrue(cloud.stops > before);
        cloud.done.run(); // 멈춘 뒤에 뒤늦게 온 완료 신호는 무시한다
        assertEquals(1, ReadService.index);
        command(ReadService.ACTION_PLAY);
        assertEquals("voice=ko-KR-SunHiNeural&text=둘.@1.0", cloud.played.get(cloud.played.size() - 1));
    }

    @Test
    public void backOnFirstScreenAsksBeforeExit() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        activity.onBackPressed();
        android.app.AlertDialog dialog = org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
        assertNotNull("맨 처음 화면에서 뒤로 가기를 누르면 종료할지 물어야 한다", dialog);
        assertTrue(dialog.isShowing());
        assertFalse(activity.isFinishing());
        dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
        shadowOf(Looper.getMainLooper()).idle();
        assertTrue(activity.isFinishing());
    }

    @Test
    public void voiceListIncludesOnlineVoices() throws Exception {
        org.json.JSONArray arr = new org.json.JSONArray(ReadService.voicesJson);
        for (int i = 0; i < arr.length(); i++) assertTrue(arr.getJSONObject(i).has("online"));
    }

    private android.speech.tts.TextToSpeech serviceTts() {
        try {
            java.lang.reflect.Field f = ReadService.class.getDeclaredField("tts");
            f.setAccessible(true);
            return (android.speech.tts.TextToSpeech) f.get(service);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
