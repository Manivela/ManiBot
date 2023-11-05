const { presenceUpdateHandler } = require("../src/handlers/presenceUpdate");

describe("Presence Update Handler", () => {
  const osuActivity = {
    id: "osuId",
    name: "osu!",
    applicationId: "osuId",
  };
  const lolActivity = {
    id: "lolId",
    name: "League of Legends",
    applicationId: "lolId",
  };
  const osuRole = { name: "osu!" };
  const osuIngameRole = { name: "osu!-ingame" };
  const member = {
    displayName: "TestMember",
    roles: {
      add: jest.fn(),
      remove: jest.fn(),
      cache: [],
    },
  };
  const guild = {
    roles: {
      cache: [osuRole, osuIngameRole],
      fetch: jest.fn(),
    },
  };

  it("adds a game role and an ingame role to the user", async () => {
    const newPresence = {
      guild,
      member,
      activities: [osuActivity],
    };
    await presenceUpdateHandler(null, newPresence);
    expect(member.roles.add).toHaveBeenCalledWith(osuRole);
    expect(member.roles.add).toHaveBeenCalledWith(osuIngameRole);
  });

  it("removes a game role from the user but keeps the game role", async () => {
    jest.replaceProperty(member.roles, "cache", [osuRole, osuIngameRole]);
    const oldPresence = {
      guild,
      member,
      activities: [osuActivity],
    };
    const newPresence = {
      guild,
      member,
      activities: [],
    };
    await presenceUpdateHandler(oldPresence, newPresence);
    expect(member.roles.remove).not.toHaveBeenCalledWith(osuRole);
    expect(member.roles.remove).toHaveBeenCalledWith(osuIngameRole);
  });

  it("exits gracefully if the guild doesn't have the required roles", async () => {
    jest.replaceProperty(guild.roles, "cache", []);
    const oldPresence = {
      guild,
      member,
      activities: [],
    };
    const newPresence = {
      guild,
      member,
      activities: [osuActivity],
    };
    await presenceUpdateHandler(oldPresence, newPresence);
    expect(member.roles.add).not.toHaveBeenCalledWith(osuRole);
    expect(member.roles.add).not.toHaveBeenCalledWith(osuIngameRole);
  });

  it("should cleanup any leftover ingame roles after every presence update", async () => {
    jest.replaceProperty(member.roles, "cache", [osuIngameRole]);
    const newPresence = {
      guild,
      member,
      activities: [lolActivity],
    };
    await presenceUpdateHandler(null, newPresence);
    expect(member.roles.remove).toHaveBeenCalledWith(osuIngameRole);
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(guild.roles.fetch).toHaveBeenCalled();
  });
  it("should keep correct ingame roles after every presence update", async () => {
    jest.replaceProperty(member.roles, "cache", [osuIngameRole]);
    const newPresence = {
      guild,
      member,
      activities: [osuActivity],
    };
    await presenceUpdateHandler(null, newPresence);
    expect(member.roles.remove).not.toHaveBeenCalledWith(osuIngameRole);
    expect(member.roles.add).not.toHaveBeenCalled();
  });
  it("shouldn't crash if it fails to fetch roles", async () => {
    jest.spyOn(guild.roles, "fetch").mockImplementation(() => {
      throw "Mock error";
    });
    const newPresence = {
      guild,
      member,
      activities: [lolActivity],
    };
    try {
      await presenceUpdateHandler(null, newPresence);
    } catch (error) {
      expect(error).toBeUndefined();
    }
  });
});
