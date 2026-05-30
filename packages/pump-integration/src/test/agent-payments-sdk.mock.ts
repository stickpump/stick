export const PumpAgentOffline = {
  load: () => ({
    create: async () => {
      throw new Error("PumpAgentOffline mock create() should not be called in launchpad tests");
    }
  })
};
