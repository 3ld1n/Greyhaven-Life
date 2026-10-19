/** Pure Greyhaven roleplay clock math. Manual time is per chat, not wall-clock time. */
export function safeManualRate(value) {
  return [1, 5, 10].includes(Number(value)) ? Number(value) : 1;
}

export function manualRoleplayTimeMs(time, realNowMs = Date.now()) {
  const anchor = Number.isFinite(Number(time?.manualAnchorRealMs)) ? Number(time.manualAnchorRealMs) : realNowMs;
  const base = Number.isFinite(Number(time?.manualEpochMs)) ? Number(time.manualEpochMs) : realNowMs;
  return base + (time?.manualRunning === false ? 0 : Math.max(0, realNowMs - anchor) / safeManualRate(time?.manualRateDivisor));
}

export function reanchorManualRate(time, divisor, realNowMs = Date.now()) {
  return {
    manualEpochMs: manualRoleplayTimeMs(time, realNowMs),
    manualAnchorRealMs: realNowMs,
    manualRateDivisor: safeManualRate(divisor),
    mode: 'manual',
  };
}
