import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusable, FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import { usePlayerStore } from '@/state/playerStore';
import { useUIStore } from '@/state/uiStore';
import { useSettingsStore, SUBTITLE_SIZE_PX } from '@/state/settingsStore';
import { usePlayer } from '@/hooks/usePlayer';
import { usePlayerController } from '@/hooks/usePlayerController';
import { useRemote } from '@/hooks/useRemote';
import { useAudioWatchdog } from '@/hooks/useAudioWatchdog';
import { useStreamWatchdog } from '@/hooks/useStreamWatchdog';
import { OSD } from './OSD';
import { ErrorOverlay } from './ErrorOverlay';
import { Spinner } from '@/components/common/Spinner';
import type { PlaybackAttempt } from '@/types/player';

export function VideoPlayer() {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleEnabled = useSettingsStore((s) => s.subtitleEnabled);
  const subtitleSize    = useSettingsStore((s) => s.subtitleSize);
  const playerState = usePlayerStore((s) => s.state);
  const error = usePlayerStore((s) => s.error);
  const currentSource = usePlayerStore((s) => s.currentSource);
  const setSource = usePlayerStore((s) => s.setSource);
  const clearError = usePlayerStore((s) => s.setError);
  const [resumeHandledSourceId, setResumeHandledSourceId] = useState<string | null>(null);
  const [pendingResumeSeconds, setPendingResumeSeconds] = useState<number | null>(null);
  const savedResumeSeconds = currentSource?.resumeAtSeconds ?? 0;
  const resumeChoicePending = Boolean(
    currentSource?.id
      && savedResumeSeconds >= 30
      && resumeHandledSourceId !== currentSource.id
  );

  const navigate = useUIStore((s) => s.navigate);
  const lastMainScreen = useUIStore((s) => s.lastMainScreen);

  // Player controls use the same TV spatial-navigation system as the rest of the app.
  const { ref, focusKey, setFocus } = useFocusable({
    focusKey: 'PLAYER_ROOT',
    isFocusBoundary: true,
    trackChildren: true,
    saveLastFocusedChild: true,
    autoRestoreFocus: false,
  });
  const handleResume = useCallback(() => {
    const video = videoRef.current;
    video?.pause();
    setResumeHandledSourceId(currentSource?.id ?? null);
    setPendingResumeSeconds(savedResumeSeconds);
  }, [currentSource?.id, savedResumeSeconds]);
  const handleRestart = useCallback(() => {
    const video = videoRef.current;
    setResumeHandledSourceId(currentSource?.id ?? null);
    setPendingResumeSeconds(null);
    if (video) {
      try { video.currentTime = 0; } catch { /* Stream henüz hazır değilse zaten 0'dan açılır. */ }
      void video.play();
    }
  }, [currentSource?.id]);
  const { ref: resumeRef, focused: resumeFocused } = useFocusable({
    focusKey: 'PLAYER_RESUME',
    onEnterPress: handleResume,
  });
  const { ref: restartRef, focused: restartFocused } = useFocusable({
    focusKey: 'PLAYER_RESTART',
    onEnterPress: handleRestart,
  });
  useEffect(() => {
    const timer = setTimeout(
      () => setFocus(resumeChoicePending ? 'PLAYER_RESUME' : 'OSD_PLAY_PAUSE'),
      80,
    );
    return () => clearTimeout(timer);
  }, [currentSource?.id, resumeChoicePending, setFocus]);

  // ─── Persistent error state ─────────────────────────────────────────────────
  // Set by onFatalError (all url × strategy combinations exhausted) OR by a
  // non-recoverable post-attach error from strategy.onError().
  const [persistentError, setPersistentError] = useState<{
    message: string;
    attempts: PlaybackAttempt[];
  } | null>(null);

  // D-031: onFatalError callback — called by usePlayer when all attempts fail.
  // useCallback so the ref identity is stable across renders (avoids usePlayer
  // effect re-firing just because the callback was re-created).
  const onFatalError = useCallback(
    (message: string, attempts: PlaybackAttempt[]) => {
      setPersistentError({ message, attempts });
    },
    [],
  );

  // Watchdog escalation: when all 3 retries fail, restart the full fallback chain.
  // Spread creates a new object → usePlayer effect dependency changes → re-run
  const handleWatchdogEscalation = useCallback(() => {
    if (currentSource) {
      console.warn('[player] watchdog escalated, restarting full fallback chain');
      setSource({ ...currentSource });
    }
  }, [currentSource, setSource]);

  const handleWatchdogRetry = useCallback(() => {
    if (currentSource) {
      console.log('[player] watchdog triggering stream re-init');
      setSource({ ...currentSource });
    }
  }, [currentSource, setSource]);

  // ─── Subtitle enable / disable ──────────────────────────────────────────────
  // Applies to HLS WebVTT / CEA-608 tracks embedded in the stream.
  // 'addtrack' listener ensures tracks added after playback starts are also covered.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const applyMode = () => {
      const mode: TextTrackMode = subtitleEnabled ? 'showing' : 'hidden';
      for (let i = 0; i < video.textTracks.length; i++) {
        video.textTracks[i].mode = mode;
      }
    };

    applyMode();
    video.textTracks.addEventListener('addtrack', applyMode);
    return () => {
      video.textTracks.removeEventListener('addtrack', applyMode);
    };
  }, [subtitleEnabled]);

  usePlayer(videoRef, onFatalError);
  const playerController = usePlayerController(videoRef, currentSource?.id);
  useRemote(playerController);
  useAudioWatchdog(videoRef);
  useStreamWatchdog({
    videoRef,
    url: currentSource?.url ?? '',
    onAllRetriesFailed: handleWatchdogEscalation,
    onRetry: handleWatchdogRetry,
    enabled: false,
  });

  // Resume seçimi yapılana kadar içeriğin arka planda ilerlemesini engelle.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resumeChoicePending) return;
    const keepPaused = () => video.pause();
    video.pause();
    video.addEventListener('play', keepPaused);
    return () => video.removeEventListener('play', keepPaused);
  }, [resumeChoicePending, currentSource?.id]);

  // Bazı webOS akışlarında seekable aralığı metadata'dan sonra oluşur. Devam Et
  // komutunu aralık hazır olana kadar beklet, sonra tek sefer uygula.
  useEffect(() => {
    if (pendingResumeSeconds === null || !playerController.canSeek || playerController.duration <= 0) return;
    const ratio = pendingResumeSeconds / playerController.duration;
    if (playerController.seekToRatio(ratio)) {
      setPendingResumeSeconds(null);
      playerController.play();
      setTimeout(() => setFocus('OSD_PLAY_PAUSE'), 0);
    }
  }, [pendingResumeSeconds, playerController, setFocus]);

  // ─── Post-attach non-recoverable error → persistent error overlay ───────────
  // strategy.onError() fires mid-stream (after successful attach). Fatal
  // mid-stream errors have no URL fallback left — show persistent overlay.
  useEffect(() => {
    if (error && !error.recoverable && !persistentError) {
      setPersistentError({ message: error.message, attempts: [] });
    }
  }, [error, persistentError]);

  const handleBack = () => {
    setPersistentError(null);
    clearError(null);
    navigate(lastMainScreen);
  };

  const handleRetry = () => {
    if (currentSource) {
      setPersistentError(null);
      clearError(null);
      // Spread creates a new object → usePlayer effect dependency changes → re-run
      setSource({ ...currentSource });
    }
  };

  return (
    <FocusContext.Provider value={focusKey}>
    <div ref={ref as React.RefObject<HTMLDivElement>} className="relative w-full h-full bg-bg-base overflow-hidden">
      {/* Dynamic subtitle font size — targets native ::cue rendering */}
      <style>{`video::cue { font-size: ${SUBTITLE_SIZE_PX[subtitleSize]}; }`}</style>

      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full"
        playsInline
        autoPlay={!resumeChoicePending}
      />

      {resumeChoicePending && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/70">
          <div className="w-[600px] rounded-2xl border border-[#E8B567]/35 bg-[#131110]/95 px-10 py-9 text-center shadow-[0_30px_80px_-25px_#000]">
            <div className="font-serif text-[30px] text-white">Kaldığınız yerden devam edilsin mi?</div>
            <div className="mt-2 text-[13px] tracking-[0.16em] text-white/55">
              {Math.floor(savedResumeSeconds / 60)}. dakikadan devam edebilirsiniz
            </div>
            <div className="mt-7 flex justify-center gap-4">
              <button
                ref={resumeRef as React.RefObject<HTMLButtonElement>}
                onClick={handleResume}
                className={[
                  'h-12 min-w-[170px] rounded-full border px-7 text-[13px] font-semibold transition-all',
                  resumeFocused
                    ? 'border-[#E8B567] bg-[#E8B567] text-[#17110A] shadow-[0_0_24px_-5px_#E8B567]'
                    : 'border-white/20 text-white/70',
                ].join(' ')}
              >
                Devam Et
              </button>
              <button
                ref={restartRef as React.RefObject<HTMLButtonElement>}
                onClick={handleRestart}
                className={[
                  'h-12 min-w-[170px] rounded-full border px-7 text-[13px] font-semibold transition-all',
                  restartFocused
                    ? 'border-[#E8B567] bg-[#E8B567] text-[#17110A] shadow-[0_0_24px_-5px_#E8B567]'
                    : 'border-white/20 text-white/70',
                ].join(' ')}
              >
                Baştan İzle
              </button>
            </div>
          </div>
        </div>
      )}

      {playerState === 'loading' && !persistentError && (
        <div className="absolute inset-0">
          <Spinner />
        </div>
      )}

      {/* Kurtarılabilir hata (ağ kesintisi) — retry butonu */}
      {playerState === 'error' && error?.recoverable && !persistentError && (
        <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-8">
          <div className="w-20 h-20 rounded-full bg-bg-surface flex items-center justify-center">
            <span className="text-display text-live">!</span>
          </div>
          <p className="text-h2 text-text-primary text-center max-w-xl px-12">
            {error.message}
          </p>
          <button
            className="px-10 py-4 bg-accent text-accent-text text-body font-medium rounded-lg"
            onClick={handleRetry}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          >
            {t('player.retry')}
          </button>
        </div>
      )}

      {/* Kalıcı hata — tüm URL × strateji adayları tükendi */}
      {persistentError && (
        <ErrorOverlay
          message={persistentError.message}
          attempts={persistentError.attempts}
          onBack={handleBack}
        />
      )}

      <OSD controller={playerController} />
    </div>
    </FocusContext.Provider>
  );
}
