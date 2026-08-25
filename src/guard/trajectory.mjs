/**
 * Trajectory engine — detect authority-expansion paths across a session.
 *
 * Signals: staging→production, read→destructive, credential scope changes,
 * recovery depth after failures (PocketOS-style trajectories).
 */

/**
 * @typedef {{
 *   type: string,
 *   detail: string,
 *   from: unknown,
 *   to: unknown,
 *   recoveryDepth: number,
 * }} TrajectorySignal
 */

/**
 * @returns {{
 *   observe: (args: { effect?: object, decision?: object|string, failure?: boolean|object }) => TrajectorySignal[],
 *   signals: () => TrajectorySignal[],
 *   reset: () => void,
 *   snapshot: () => object,
 * }}
 */
export function createTrajectoryTracker() {
  /** @type {Array<{ t: string, effect: any, decision: any, failure: boolean }>} */
  const history = [];
  /** @type {TrajectorySignal[]} */
  const emitted = [];

  let lastEnvironment = null;
  let lastEffectKind = null; // read|write|destructive|…
  let lastCredential = null;
  let recoveryDepth = 0;
  let consecutiveFailures = 0;

  /**
   * @param {{ effect?: any, decision?: any, failure?: boolean|object }} args
   */
  function observe({ effect = null, decision = null, failure = false } = {}) {
    const isFailure =
      failure === true ||
      (failure && typeof failure === "object") ||
      (decision && typeof decision === "object" && /fail|error|denied|reject/i.test(String(decision.reason || ""))) ||
      (typeof decision === "string" && /fail|error/i.test(decision));

    if (isFailure) {
      consecutiveFailures += 1;
      recoveryDepth = consecutiveFailures;
    } else if (decisionAllows(decision) && effect) {
      // successful step after failures still carries recovery depth until reset by benign progress
      if (consecutiveFailures > 0 && isEscalating(effect)) {
        recoveryDepth = consecutiveFailures;
      } else if (consecutiveFailures > 0 && !isEscalating(effect)) {
        // recovery attempt that is not escalating — depth retained for signal, counter soft-decays
        consecutiveFailures = Math.max(0, consecutiveFailures - 1);
      }
    }

    const newly = [];

    const env = effect?.environment ? String(effect.environment) : null;
    const cred = effect?.credential ? String(effect.credential) : null;
    const kind = classifyKind(effect);

    if (lastEnvironment === "staging" && env === "production") {
      newly.push(
        signal("AUTHORITY_EXPANSION", "Environment escalation: staging → production", "staging", "production", recoveryDepth),
      );
    } else if (lastEnvironment && env && lastEnvironment !== env && privilegeRank(env) > privilegeRank(lastEnvironment)) {
      newly.push(
        signal("AUTHORITY_EXPANSION", `Environment escalation: ${lastEnvironment} → ${env}`, lastEnvironment, env, recoveryDepth),
      );
    }

    if (
      (lastEffectKind === "read" || lastEffectKind === "write") &&
      kind === "destructive"
    ) {
      newly.push(
        signal(
          "CONSEQUENCE_ESCALATION",
          "Effect escalation: read/write → destructive",
          lastEffectKind,
          "destructive",
          recoveryDepth,
        ),
      );
    }

    if (lastCredential && cred && lastCredential !== cred) {
      if (privilegeRank(cred) > privilegeRank(lastCredential) || cred === "production" || cred === "secret") {
        newly.push(
          signal(
            "CREDENTIAL_SCOPE_CHANGE",
            `Credential scope change: ${lastCredential} → ${cred}`,
            lastCredential,
            cred,
            recoveryDepth,
          ),
        );
      }
    } else if (!lastCredential && cred && (cred === "production" || cred === "secret") && recoveryDepth > 0) {
      newly.push(
        signal(
          "CREDENTIAL_SCOPE_CHANGE",
          `Credential discovery after failure: ${cred}`,
          null,
          cred,
          recoveryDepth,
        ),
      );
    }

    if (recoveryDepth >= 2 && isEscalating(effect)) {
      newly.push(
        signal(
          "RECOVERY_ESCALATION",
          `Recovery depth ${recoveryDepth} with escalating effect (PocketOS-style trajectory)`,
          recoveryDepth,
          effect?.effect ?? kind,
          recoveryDepth,
        ),
      );
    }

    if (env === "production" && effect?.destructive === true) {
      newly.push(
        signal(
          "PRODUCTION_DESTRUCTIVE",
          "Destructive effect targeting production",
          lastEnvironment,
          "production+destructive",
          recoveryDepth,
        ),
      );
    }

    history.push({
      t: new Date().toISOString(),
      effect,
      decision,
      failure: Boolean(isFailure),
    });

    if (env) lastEnvironment = env;
    if (kind) lastEffectKind = kind;
    if (cred) lastCredential = cred;

    for (const s of newly) emitted.push(s);
    return newly;
  }

  function signals() {
    return emitted.slice();
  }

  function reset() {
    history.length = 0;
    emitted.length = 0;
    lastEnvironment = null;
    lastEffectKind = null;
    lastCredential = null;
    recoveryDepth = 0;
    consecutiveFailures = 0;
  }

  function snapshot() {
    return {
      lastEnvironment,
      lastEffectKind,
      lastCredential,
      recoveryDepth,
      consecutiveFailures,
      historyLength: history.length,
      signalCount: emitted.length,
    };
  }

  return { observe, signals, reset, snapshot };
}

function signal(type, detail, from, to, recoveryDepth) {
  return { type, detail, from, to, recoveryDepth: recoveryDepth || 0 };
}

function decisionAllows(decision) {
  if (!decision) return false;
  if (typeof decision === "string") {
    const d = decision.toUpperCase();
    return d === "ALLOW" || d === "APPROVE" || d === "ALLOWED";
  }
  const d = String(decision.decision || decision.permissionDecision || "").toUpperCase();
  return d === "ALLOW" || d === "APPROVE" || d === "ALLOWED";
}

function classifyKind(effect) {
  if (!effect) return null;
  if (effect.destructive === true || effect.effect === "delete" || effect.effect === "deploy") {
    return "destructive";
  }
  if (effect.effect === "write" || effect.effect === "edit" || effect.effect === "push" || effect.effect === "publish") {
    return "write";
  }
  if (effect.effect === "read" || effect.effect === "fetch" || effect.effect === "search" || effect.effect === "query") {
    return "read";
  }
  return effect.effect ? String(effect.effect) : null;
}

function isEscalating(effect) {
  if (!effect) return false;
  return (
    effect.environment === "production" ||
    effect.destructive === true ||
    effect.credential === "production" ||
    effect.credential === "secret" ||
    effect.effect === "delete" ||
    effect.effect === "deploy"
  );
}

function privilegeRank(label) {
  const l = String(label || "").toLowerCase();
  if (l === "production" || l === "prod") return 3;
  if (l === "secret" || l === "aws") return 2;
  if (l === "staging" || l === "stage") return 1;
  if (l === "development" || l === "dev" || l === "local") return 0;
  return 0;
}
