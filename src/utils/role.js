async function findRole(serverRoles, roleName) {
  // search for role in cache
  let role = serverRoles.cache.find((r) => r.name === roleName);
  if (!role) {
    // fetch new roles from the server
    try {
      await serverRoles.fetch(); // Fetch all roles from the server to ensure the cache is up to date
      role = serverRoles.cache.find((r) => r.name === roleName); // Search again after fetching
      if (!role) {
        console.log(`${roleName} not found on the server.`);
      }
    } catch (error) {
      console.error("Error while fetching roles:", error);
    }
  }
  return role;
}

function hasRole(member, roleName) {
  return member.roles.cache.some((role) => role.name === roleName);
}
module.exports = { findRole, hasRole };
