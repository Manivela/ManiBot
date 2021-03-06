require('dotenv').config();
const { Client, Intents } = require('discord.js');
const slugify = require('slugify');
const axios = require('axios');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_PRESENCES, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_VOICE_STATES, Intents.FLAGS.GUILDS] });

client.on('ready', async () => {
    await Promise.all(client.guilds.cache.map(async g => {
        return g.roles.fetch().then(roles => console.log(`fetched ${roles.size} roles for ${g.name}`));
    }));
    console.log('------------Bot is ready------------');
});
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'register') {
        axios({
            method: 'post',
            url: `https://my.zerotier.com/api/v1/network/${process.env.ZERO_TIER_NETWORK}/member/${interaction.options.getString('address')}`,
            headers: {
                'Authorization': `Bearer ${process.env.ZERO_TIER_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({
                'name': `${interaction.user.username}`,
                'description': 'Authenticated from discord',
                'config': {
                    'authorized': true,
                },
            }),
        })
            .then(async () => {
                await interaction.reply({ content: 'Authorized!', ephemeral: true });
            })
            .catch(async (error) => {
                console.log('error: ', error);
                await interaction.reply({ content: 'An error occurred!', ephemeral: true });
            });
    }
});
// client.on('messageCreate', msg => {
//     if (msg.content === 'marco') {
//         console.log(
//             'polo',
//         );
//     }
// });
// clear ingame roles every 5 minutes
setInterval(() => {
    client.guilds.cache.map(guild => {
        guild.members.cache.forEach(member => {
            const role = member.roles.cache.find(r => r.name.includes('-ingame'));
            if (!role) {
                return;
            }
            if (!member.presence || !member.presence.activities.find(presence => presence.name === role.name.replace('-ingame', ''))) {
                member.roles.remove(role).then(() => `stale role "${role.name}" removed from "${member.displayName}"`).catch(reason => {
                    console.log(`failed to remove stale role "${role.name}" from "${member.name}"! reason: ${reason}`);
                });
            }
        });
    });
}, 300000);
client.on('presenceUpdate', (oldPresence, newPresence) => {
    const member = oldPresence ? oldPresence.member : newPresence.member;
    if (!member.presence.activities || member.presence.activities.length == 0 || !member.presence.activities.some(a => !!a.applicationId)) {
        // not playing a game
        return;
    }
    newPresence.activities.filter(a => !!a.applicationId).forEach(async activity => {
        const roleName = activity.name;
        // only add if the user doesn't already have the role
        if (hasRole(member, roleName)) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`"${member.displayName}" already has role "${roleName}"`);
            }
            return;
        }
        const role = await findRole(newPresence.guild.roles, roleName);

        if (!role) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`role "${roleName}" not found on this server.`);
            }
            return;
        }
        member.roles.add(role).then(() => `role "${role.name}" added to "${member.displayName}"`).catch(reason => {
            console.log(`failed to add role "${role.name}" to "${member.name}"! reason: ${reason}`);
        });
    });
    newPresence.activities.filter(a => !!a.applicationId).forEach(async activity => {
        const inGameRoleName = `${activity.name}-ingame`;
        // only add if the user doesn't already have the role
        if (hasRole(member, inGameRoleName)) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`"${member.displayName}" already has role "${inGameRoleName}"`);
            }
            return;
        }
        const inGameRole = await findRole(newPresence.guild.roles, inGameRoleName);

        if (!inGameRole) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`role "${inGameRoleName}" not found on this server.`);
            }
            return;
        }
        member.roles.add(inGameRole).then(() => `role "${inGameRole.name}" added to "${member.displayName}"`).catch(reason => {
            console.log(`failed to add role "${inGameRole.name}" to "${member.name}"! reason: ${reason}`);
        });
    });
    oldPresence.activities.filter(a => !!a.applicationId).forEach(async activity => {
        const inGameRoleName = `${activity.name}-ingame`;
        // only remove if the user already has the role
        if (!hasRole(member, inGameRoleName)) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`"${member.displayName}" doesn't have role "${inGameRoleName}"`);
            }
            return;
        }
        const inGameRole = await findRole(newPresence.guild.roles, inGameRoleName);

        if (!inGameRole) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`role "${inGameRoleName}" not found on this server.`);
            }
            return;
        }
        member.roles.remove(inGameRole).then(() => `role "${inGameRole.name}" removed from "${member.displayName}"`).catch(reason => {
            console.log(`failed to remove role "${inGameRole.name}" from "${member.name}"! reason: ${reason}`);
        });
    });
});
client.on('voiceStateUpdate', async (oldState, newState) => {
    const newUserChannel = newState.channel;
    const oldUserChannel = oldState.channel;
    if (oldUserChannel === newUserChannel) {
        return;
    }
    if (newUserChannel !== null) {
        const channelName = `${slugify(newUserChannel.name, { lower: true })}-bot`;
        const foundChannel = findChannel(newState.guild.channels, channelName);
        if (foundChannel && newUserChannel.parentId === foundChannel.parentId) {
            foundChannel.permissionOverwrites.create(newState.member, { 'VIEW_CHANNEL': true, 'SEND_MESSAGES': true, 'READ_MESSAGE_HISTORY': true })
                .then(channel => console.log(`added "${newState.member.displayName}" to channel "${channel.name}"`))
                .catch(e => console.log(`failed to add permissions for ${newState.member.displayName}: `, e));
        }
        else {
            newUserChannel.parent.createChannel(channelName, {
                type: 'GUILD_TEXT',
                permissionOverwrites: [
                    {
                        // Watora
                        id: '220644154177355777',
                        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'],
                    },
                    {
                        // Bot
                        id: client.user.id,
                        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'],
                    },
                    {
                        // User that joined the vc
                        id: newState.member.id,
                        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'],
                    },
                    {
                        // @everyone
                        id: newState.guild.roles.everyone.id,
                        deny: ['VIEW_CHANNEL'],
                    },
                ],
            }).then(channel => {
                console.log(`created channel "${channel.name}" for member "${newState.member.displayName}"`);
            }).catch(e => console.log(`failed to create channel ${channelName}: `, e));
        }
    }
    if (oldUserChannel !== null) {
        const channelName = `${slugify(oldUserChannel.name, { lower: true })}-bot`;
        const foundChannel = findChannel(newState.guild.channels, channelName);
        if (foundChannel && oldUserChannel.parentId === foundChannel.parentId) {
            if (oldUserChannel.members.size === 0) {
                foundChannel.delete()
                    .then(channel => console.log(`removed channel "${channel.name}"`))
                    .catch(e => console.log(`failed to delete channel ${channelName}: `, e));
            }
            // if not Watora
            else if (newState.member.id !== '220644154177355777') {
                foundChannel.permissionOverwrites
                    .delete(newState.member)
                    .then(channel => console.log(`removed "${newState.member.displayName}" from channel "${channel.name}"`))
                    .catch(e => console.log(`failed to remove permissions for ${newState.member.displayName}: `, e));
            }
        }
    }
});

function findChannel(serverChannels, channelName) {
    return serverChannels.cache.find(channel => channel.type === 'GUILD_TEXT' && channel.name === channelName);
}

async function findRole(serverRoles, roleName) {
    // search for role in cache
    let role = serverRoles.cache.find(r => r.name === roleName);
    if (!role) {
        // fetch new roles from the server
        try {
            role = await serverRoles.fetch(roles => {
                console.log(`${roleName} not found in cache fetching it from server`);
                return roles.find(r => r.name === roleName);
            });
        }
        catch (error) {
            console.error('error while fetching roles:', error);
            return;
        }
    }
    return role;
}
function hasRole(member, roleName) {
    return member.roles.cache.some(role => role.name === roleName);
}
client.login(process.env.BOT_TOKEN);