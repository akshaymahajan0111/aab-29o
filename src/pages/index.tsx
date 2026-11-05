import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Helmet } from '@dr.pogodin/react-helmet';

// ─── Types ────────────────────────────────────────────────────────────────────

type GameState = 'idle' | 'playing' | 'gameover';

interface Tile {
  id: number;
  isOdd: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUND_TIME = 10;
const LIVES_MAX = 3;
const GAME_COLOURS = [
  { h: 220, s: 85 },
  { h: 340, s: 80 },
  { h: 145, s: 70 },
  { h: 35,  s: 90 },
  { h: 270, s: 75 },
  { h: 185, s: 80 },
  { h: 10,  s: 85 },
];

function getGridSize(score: number): number {
  if (score >= 100) return 5;
  if (score >= 50)  return 4;
  return 3;
}

function getDelta(score: number): number {
  const min = 8;
  const max = 30;
  const factor = Math.min(score / 120, 1);
  return Math.round(max - (max - min) * factor);
}

function buildTiles(gridSize: number): Tile[] {
  const count = gridSize * gridSize;
  const oddIndex = Math.floor(Math.random() * count);
  return Array.from({ length: count }, (_, i) => ({ id: i, isOdd: i === oddIndex }));
}

function pickColour(score: number): { h: number; s: number; l: number; oddL: number } {
  const { h, s } = GAME_COLOURS[Math.floor(Math.random() * GAME_COLOURS.length)];
  const l = 45 + Math.floor(Math.random() * 20);
  const delta = getDelta(score);
  const oddL = l + (Math.random() > 0.5 ? delta : -delta);
  return { h, s, l, oddL: Math.max(10, Math.min(90, oddL)) };
}

function playBeep(type: 'correct' | 'wrong') {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = type === 'correct' ? 880 : 220;
    osc.type = type === 'correct' ? 'sine' : 'sawtooth';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // silent fallback
  }
}

export default function ColourVisionTest() {
  const [gameState, setGameState] = useState<GameState>('idle');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(LIVES_MAX);
  const [round, setRound] = useState(1);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [colour, setColour] = useState({ h: 220, s: 85, l: 55, oddL: 75 });
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [flash, setFlash] = useState<'correct' | 'wrong' | null>(null);
  const [wrongTile, setWrongTile] = useState<number | null>(null);
  const [bestScore, setBestScore] = useState(() => {
    try { return parseInt(localStorage.getItem('cvt-best') ?? '0', 10); } catch { return 0; }
  });
  const [roundKey, setRoundKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const gridSize = getGridSize(score);

  const startRound = useCallback((currentScore: number) => {
    const gs = getGridSize(currentScore);
    setTiles(buildTiles(gs));
    setColour(pickColour(currentScore));
    setTimeLeft(ROUND_TIME);
    setWrongTile(null);
    setRoundKey(k => k + 1);
  }, []);

  const startGame = useCallback(() => {
    setScore(0);
    setLives(LIVES_MAX);
    setRound(1);
    startRound(0);
    setGameState('playing');
  }, [startRound]);

  useEffect(() => {
    if (gameState !== 'playing') {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setTimeLeft(t => {
        if (t <= 1) {
          clearInterval(timerRef.current!);
          setLives(l => {
            const next = l - 1;
            if (next <= 0) {
              setGameState('gameover');
            } else {
              setFlash('wrong');
              setTimeout(() => setFlash(null), 400);
              setRound(r => r + 1);
              setScore(s => { startRound(s); return s; });
            }
            return next;
          });
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [gameState, roundKey, startRound]);

  useEffect(() => {
    if (gameState === 'gameover' && score > bestScore) {
      setBestScore(score);
      try { localStorage.setItem('cvt-best', String(score)); } catch { /* noop */ }
    }
  }, [gameState, score, bestScore]);

  const handleTileClick = useCallback((tile: Tile) => {
    if (gameState !== 'playing') return;
    if (timerRef.current) clearInterval(timerRef.current);

    if (tile.isOdd) {
      playBeep('correct');
      setFlash('correct');
      setTimeout(() => setFlash(null), 400);
      setScore(s => {
        const next = s + 10;
        setRound(r => r + 1);
        startRound(next);
        return next;
      });
    } else {
      playBeep('wrong');
      setWrongTile(tile.id);
      setFlash('wrong');
      setTimeout(() => setFlash(null), 400);
      setLives(l => {
        const next = l - 1;
        if (next <= 0) {
          setGameState('gameover');
        } else {
          setTimeout(() => {
            setRound(r => r + 1);
            setScore(s => { startRound(s); return s; });
          }, 600);
        }
        return next;
      });
    }
  }, [gameState, startRound]);

  const tileSize = gridSize === 5
    ? 'w-14 h-14 sm:w-16 sm:h-16 md:w-20 md:h-20'
    : gridSize === 4
    ? 'w-16 h-16 sm:w-20 sm:h-20 md:w-24 md:h-24'
    : 'w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28';

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden select-none"
      style={{ background: 'hsl(var(--background))' }}
    >
      <Helmet>
        <title>Colour Vision Test — Spot the Odd One Out</title>
        <meta name="description" content="Test your colour perception! Spot the tile with a different shade before time runs out. A fun pattern recognition game." />
      </Helmet>
      {/* Flash overlay */}
      <AnimatePresence>
        {flash && (
          <motion.div
            key={flash + String(roundKey)}
            className="absolute inset-0 pointer-events-none z-50"
            style={{
              background: flash === 'correct'
                ? 'rgba(16,185,129,0.18)'
                : 'rgba(239,68,68,0.18)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {/* ── IDLE ── */}
        {gameState === 'idle' && (
          <motion.div
            key="idle"
            className="flex flex-col items-center gap-8 px-6 text-center"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.4, ease: 'easeOut' as const }}
          >
            <motion.div
              animate={{ rotate: [0, -4, 4, -4, 0] }}
              transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
            >
              <h1
                className="text-5xl sm:text-6xl font-black tracking-tight"
                style={{ fontFamily: 'var(--font-heading)', color: 'hsl(var(--foreground))' }}
              >
                Colour Vision
              </h1>
              <p className="text-2xl sm:text-3xl font-bold mt-1" style={{ color: 'hsl(var(--primary))' }}>
                Test
              </p>
            </motion.div>

            <p className="text-base sm:text-lg max-w-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
              Spot the tile with a different shade. Tap it before time runs out!
            </p>

            <div className="grid grid-cols-3 gap-3">
              {[false, false, true, false, false, false, false, false, false].map((odd, i) => (
                <div
                  key={i}
                  className="w-14 h-14 rounded-2xl"
                  style={{ background: odd ? 'hsl(220 85% 72%)' : 'hsl(220 85% 55%)' }}
                />
              ))}
            </div>

            <motion.button
              className="px-10 py-4 rounded-3xl text-xl font-black tracking-wide"
              style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.95 }}
              onClick={startGame}
            >
              Play Now
            </motion.button>

            {bestScore > 0 && (
              <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Best score: <span className="font-bold" style={{ color: 'hsl(var(--accent))' }}>{bestScore}</span>
              </p>
            )}
          </motion.div>
        )}

        {/* ── PLAYING ── */}
        {gameState === 'playing' && (
          <motion.div
            key="playing"
            className="flex flex-col items-center gap-6 w-full px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* HUD */}
            <div className="flex items-center justify-between w-full max-w-sm">
              <motion.div
                key={score}
                initial={{ scale: 1.4 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 15 }}
              >
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'hsl(var(--muted-foreground))' }}>Score</p>
                <p className="text-3xl font-black" style={{ fontFamily: 'var(--font-heading)', color: 'hsl(var(--foreground))' }}>{score}</p>
              </motion.div>

              <div className="flex gap-1 text-2xl">
                {Array.from({ length: LIVES_MAX }, (_, i) => (
                  <motion.span
                    key={i}
                    animate={i >= lives ? { scale: [1, 1.3, 0.8, 1] } : {}}
                    transition={{ duration: 0.3 }}
                    style={{ opacity: i < lives ? 1 : 0.2 }}
                  >
                    ❤️
                  </motion.span>
                ))}
              </div>

              <div className="text-right">
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'hsl(var(--muted-foreground))' }}>Round</p>
                <p className="text-3xl font-black" style={{ fontFamily: 'var(--font-heading)', color: 'hsl(var(--foreground))' }}>{round}</p>
              </div>
            </div>

            {/* Timer bar */}
            <div className="w-full max-w-sm h-2 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }}>
              <motion.div
                className="h-full rounded-full"
                style={{
                  background: timeLeft > 5 ? 'hsl(var(--primary))' : 'hsl(var(--destructive))',
                  width: `${(timeLeft / ROUND_TIME) * 100}%`,
                }}
                transition={{ duration: 0.9, ease: 'linear' as const }}
              />
            </div>

            {/* Tile grid */}
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}
            >
              {tiles.map((tile, i) => (
                <motion.button
                  key={`${roundKey}-${tile.id}`}
                  className={`${tileSize} rounded-3xl cursor-pointer border-0 outline-none`}
                  style={{
                    background: tile.isOdd
                      ? `hsl(${colour.h} ${colour.s}% ${colour.oddL}%)`
                      : `hsl(${colour.h} ${colour.s}% ${colour.l}%)`,
                  }}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={
                    wrongTile === tile.id
                      ? { x: [0, -8, 8, -8, 8, 0], opacity: 1, scale: 1 }
                      : { opacity: 1, scale: 1 }
                  }
                  transition={
                    wrongTile === tile.id
                      ? { duration: 0.4, ease: 'easeInOut' as const }
                      : { delay: i * 0.04, type: 'spring', stiffness: 300, damping: 20 }
                  }
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.93 }}
                  onClick={() => handleTileClick(tile)}
                  aria-label={`Colour tile ${tile.id + 1}`}
                />
              ))}
            </div>

            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
              Tap the tile that looks different
            </p>
          </motion.div>
        )}

        {/* ── GAME OVER ── */}
        {gameState === 'gameover' && (
          <motion.div
            key="gameover"
            className="flex flex-col items-center gap-6 px-6 text-center"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          >
            <p className="text-5xl">💀</p>
            <h2
              className="text-4xl sm:text-5xl font-black"
              style={{ fontFamily: 'var(--font-heading)', color: 'hsl(var(--foreground))' }}
            >
              Game Over
            </h2>

            <div
              className="rounded-3xl px-10 py-6 flex flex-col items-center gap-1"
              style={{ background: 'hsl(var(--muted))' }}
            >
              <p className="text-sm font-semibold uppercase tracking-widest" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Final Score
              </p>
              <motion.p
                className="text-6xl font-black"
                style={{ fontFamily: 'var(--font-heading)', color: 'hsl(var(--primary))' }}
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 15, delay: 0.2 }}
              >
                {score}
              </motion.p>
              {score >= bestScore && score > 0 && (
                <p className="text-sm font-bold" style={{ color: 'hsl(var(--accent))' }}>
                  🏆 New best!
                </p>
              )}
              {bestScore > 0 && score < bestScore && (
                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  Best: <span className="font-bold">{bestScore}</span>
                </p>
              )}
            </div>

            <motion.button
              className="px-10 py-4 rounded-3xl text-xl font-black tracking-wide"
              style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.95 }}
              onClick={startGame}
            >
              Play Again
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
