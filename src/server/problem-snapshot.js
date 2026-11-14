/** Server-owned, immutable problem context. Never accept reference material from a client. */
export function captureProblem(problem, { originalStem, image } = {}) {
  if (!problem) return null;
  return {
    version: 1, capturedAt: new Date().toISOString(),
    originalStem: typeof originalStem === 'string' ? originalStem.slice(0, 80000) : problem.stem,
    confirmedStem: problem.stem,
    // An attachment is evidence only, never a trusted answer or grading rule.
    image: typeof image === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(image) && image.length <= 2400000
      ? image : null,
    source: problem.source ?? 'library',
    bankId: problem.source === 'qbank' ? problem.id : null,
    problem: structuredClone(problem),
  };
}

export function sessionProblem(session, current = null) {
  const saved = session?.problemSnapshot?.problem;
  return saved && saved.id === session?.problemId ? saved : current;
}

/** Legacy sessions can still have a process report even if their problem is gone. */
export function missingProblem(problemId) {
  return { id: problemId, subject: 'unknown', source: 'session-only', stem: '',
    topics: [], asked: [], givens: [], solutionGraphs: [], misconceptions: [],
    referenceAnswer: '', answerFingerprints: [], difficulty: null };
}
