import path from "node:path";
import { getDataDir } from "../data-dir";
import { getSessionRepository } from "../session-service";
import { readProjectCatalog } from "../project-catalog";
import { resolveWorkspace } from "../project-apps/workspace";
import { ProductivityError } from "../productivity-errors";
import { reportError } from "../error-utils";
import { CouncilRepository } from "./repository";
import { CouncilService } from "./service";
import { CouncilAgentRuntime } from "./runtime";
let service: CouncilService | null = null;
export function getCouncilService(): CouncilService {
  if (service)
    return service;
  const repository = getSessionRepository();
  service = new CouncilService({
    store: new CouncilRepository(path.join(getDataDir(), "councils")),
    runtime: new CouncilAgentRuntime(),
    projectBlocked: id => repository.isProjectBlocked(id),
    validateWorkspace: async (binding) => {
      const project = readProjectCatalog(getDataDir(), true).find(p => p.id === binding.projectId);
      if (!project || repository.isProjectBlocked(project.id))
        throw new ProductivityError("TARGET_GONE", "Council project unavailable");
      return (await resolveWorkspace(project, binding)).binding;
    },
    lease: (projectId, id, stop) => repository.bindProjectRuntime(projectId, id, stop),
    report: error => {
      reportError("COUNCIL", error);
    }
  });
  return service;
}
