export interface DebugLoopTargets {
  exerciseCwd: string;
  desktopCwd: string;
  usesSeparateDesktopChat: boolean;
}

export interface DebugLoopProjectCandidate {
  id: string;
  cwd: string;
  title: string;
}

export function resolveDebugLoopTargets(
  selectedProjectCwd: string,
  debugWorkspaceCwd: string | null,
): DebugLoopTargets {
  const normalizedSelectedProjectCwd = selectedProjectCwd.trim();
  const normalizedDebugWorkspaceCwd = debugWorkspaceCwd?.trim() ?? "";

  if (
    normalizedDebugWorkspaceCwd
    && normalizedDebugWorkspaceCwd !== normalizedSelectedProjectCwd
  ) {
    return {
      exerciseCwd: normalizedDebugWorkspaceCwd,
      desktopCwd: normalizedSelectedProjectCwd,
      usesSeparateDesktopChat: true,
    };
  }

  return {
    exerciseCwd: normalizedSelectedProjectCwd,
    desktopCwd: normalizedSelectedProjectCwd,
    usesSeparateDesktopChat: false,
  };
}

export function selectDebugLoopProject(
  projects: DebugLoopProjectCandidate[],
  input: {
    explicitProjectId?: string | null;
    explicitProjectMatch?: string | null;
    preferredCwd?: string | null;
  },
): DebugLoopProjectCandidate | undefined {
  const explicitProjectId = input.explicitProjectId?.trim();
  const explicitProjectMatch = input.explicitProjectMatch?.trim().toLowerCase();
  const preferredCwd = input.preferredCwd?.trim();

  if (explicitProjectId) {
    const matchedById = projects.find((project) => project.id === explicitProjectId);
    if (matchedById) {
      return matchedById;
    }
  }

  if (preferredCwd) {
    const matchedByCwd = projects.find((project) => project.cwd === preferredCwd);
    if (matchedByCwd) {
      return matchedByCwd;
    }
  }

  if (explicitProjectMatch) {
    const matchedByTitle = projects.find((project) =>
      project.title.toLowerCase().includes(explicitProjectMatch));
    if (matchedByTitle) {
      return matchedByTitle;
    }
  }

  return projects[0];
}
