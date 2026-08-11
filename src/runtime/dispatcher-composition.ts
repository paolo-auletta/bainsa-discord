import type { CommandDefinition } from './command-registry.js';
import type { ComponentHandler, InteractionDispatcherOptions } from './dispatcher.js';

/**
 * The production interaction-routing topology, kept separate from bot startup
 * so it can be asserted without opening a Discord connection.
 */
export interface DispatcherCompositionDependencies {
  commands: readonly CommandDefinition[];
  governanceCommandPanels: ComponentHandler;
  governanceMembershipPanels: ComponentHandler;
  boardUpdatePanel: ComponentHandler;
  projectManagementPanels: ComponentHandler;
  onboarding: ComponentHandler;
  guide: ComponentHandler;
  projectSetup: ComponentHandler;
  profiles: ComponentHandler;
}

export function composeInteractionDispatcher({
  commands,
  governanceCommandPanels,
  governanceMembershipPanels,
  boardUpdatePanel,
  projectManagementPanels,
  onboarding,
  guide,
  projectSetup,
  profiles,
}: DispatcherCompositionDependencies): InteractionDispatcherOptions {
  return {
    commands,
    // First match wins for component handlers. Keep this order explicit and
    // covered by the production-composition test.
    componentHandlers: [
      governanceCommandPanels,
      governanceMembershipPanels,
      boardUpdatePanel,
      projectManagementPanels,
    ],
    onboarding,
    guide,
    projectSetup,
    profiles,
  };
}
