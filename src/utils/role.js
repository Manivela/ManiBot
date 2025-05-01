const debug = require("debug")("utils:role");
const Sentry = require("@sentry/node");

async function findRole(serverRoles, roleName) {
  if (!roleName) {
    debug("No role name provided");
    return null;
  }

  let role = serverRoles.cache.find((r) => r.name === roleName);

  if (!role) {
    try {
      await serverRoles.fetch();
      role = serverRoles.cache.find((r) => r.name === roleName);

      if (!role) {
        debug(`${roleName} not found on the server.`);
      }
    } catch (error) {
      Sentry.captureException(error, (scope) => {
        scope.addBreadcrumb({
          level: "error",
          type: "debug",
          category: "roles",
          message: `Error fetching role ${roleName}`,
        });
      });
      debug(`Error while fetching roles: ${error.message}`);
    }
  }

  return role;
}

function hasRole(member, roleName) {
  if (!member || !member.roles || !roleName) return false;
  return member.roles.cache.some((role) => role.name === roleName);
}

module.exports = { findRole, hasRole };
