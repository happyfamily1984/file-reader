package app.readforme.twa;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/**
 * 온라인 AI 목소리 재생기. 서버가 만들어 주는 MP3 주소를 받아 재생한다.
 * 다음 문장을 미리 받아 두어(preload) 문장 사이가 끊기지 않게 한다.
 * 모든 메서드와 콜백은 메인 스레드에서 불린다.
 */
interface CloudAudio {
    /** url 의 음성을 speed 배속으로 재생한다. 끝나면 onDone, 받지 못하거나 재생에 실패하면 onError. */
    void play(String url, float speed, Runnable onDone, Runnable onError);

    /** 다음에 재생할 음성을 미리 받아 둔다. */
    void preload(String url);

    /** 재생을 멈춘다. 미리 받아 둔 것은 남긴다. */
    void stop();

    /** 모두 정리한다. */
    void release();

    interface Factory {
        CloudAudio create(Context context);
    }

    /** 실제 구현: MediaPlayer 두 개(지금 것, 다음 것)를 쓴다. */
    final class Media implements CloudAudio {
        private static final long TIMEOUT_MS = 15000;

        private static final class Item {
            MediaPlayer mp;
            String url;
            boolean ready, failed, started;
            float speed = 1f;
            Runnable onDone, onError;
        }

        private final Handler main = new Handler(Looper.getMainLooper());
        private Item current, next;

        private Item open(final String url) {
            final Item item = new Item();
            item.url = url;
            try {
                MediaPlayer mp = new MediaPlayer();
                item.mp = mp;
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                    @Override public void onPrepared(MediaPlayer p) {
                        item.ready = true;
                        if (item == current) begin(item);
                    }
                });
                mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                    @Override public void onCompletion(MediaPlayer p) {
                        if (item == current && !item.failed && item.onDone != null) {
                            Runnable done = item.onDone;
                            item.onDone = null;
                            done.run();
                        }
                    }
                });
                mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                    @Override public boolean onError(MediaPlayer p, int what, int extra) {
                        fail(item);
                        return true;
                    }
                });
                mp.setDataSource(url);
                mp.prepareAsync();
            } catch (Exception e) {
                item.failed = true;
            }
            return item;
        }

        private void begin(Item item) {
            if (item.started || item.failed) return;
            try {
                if (Build.VERSION.SDK_INT >= 23 && item.speed != 1f) {
                    item.mp.setPlaybackParams(item.mp.getPlaybackParams().setSpeed(item.speed)); // 음높이는 그대로, 빠르기만
                }
                item.mp.start();
                item.started = true;
            } catch (Exception e) {
                fail(item);
            }
        }

        private void fail(Item item) {
            if (item.failed) return;
            item.failed = true;
            if (item == current && item.onError != null) {
                Runnable error = item.onError;
                item.onError = null;
                item.onDone = null;
                error.run();
            }
        }

        private static void close(Item item) {
            if (item == null || item.mp == null) return;
            item.onDone = null;
            item.onError = null;
            try {
                item.mp.release();
            } catch (Exception ignored) {
                // 이미 정리됨
            }
            item.mp = null;
        }

        @Override
        public void play(String url, float speed, Runnable onDone, Runnable onError) {
            close(current);
            final Item item;
            if (next != null && url.equals(next.url) && !next.failed) {
                item = next; // 미리 받아 둔 것을 쓴다
                next = null;
            } else {
                item = open(url);
            }
            current = item;
            item.speed = speed;
            item.onDone = onDone;
            item.onError = onError;
            if (item.failed) {
                // open 이 바로 실패한 경우: 부르는 쪽이 정리를 마친 뒤 알린다.
                main.post(new Runnable() { @Override public void run() {
                    item.failed = false;
                    fail(item);
                } });
                return;
            }
            if (item.ready) begin(item);
            main.postDelayed(new Runnable() { @Override public void run() {
                if (item == current && !item.started) fail(item); // 너무 오래 걸리면 포기
            } }, TIMEOUT_MS);
        }

        @Override
        public void preload(String url) {
            if (next != null && url.equals(next.url)) return;
            close(next);
            next = open(url);
        }

        @Override
        public void stop() {
            close(current);
            current = null;
        }

        @Override
        public void release() {
            stop();
            close(next);
            next = null;
            main.removeCallbacksAndMessages(null);
        }
    }
}
