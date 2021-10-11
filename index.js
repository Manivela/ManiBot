require('dotenv').config();
const { Client, Intents } = require('discord.js');
const slugify = require('slugify');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_PRESENCES, Intents.FLAGS.GUILD_MEMBERS, Intents.FLAGS.GUILD_VOICE_STATES, Intents.FLAGS.GUILDS] });

client.login(process.env.BOT_TOKEN);
client.on('ready', async () => {
    await Promise.all(client.guilds.cache.map(async g => {
        return g.roles.fetch().then(roles => console.log(`fetched ${roles.size} roles for ${g.name}`));
    }));
    console.log('------------Bot is ready------------');
});
// client.on('messageCreate', msg => {
//     if (msg.content === 'marco') {
//         console.log(
//             'polo',
//         );
//     }
// });
client.on('presenceUpdate', (_oldPresence, newPresence) => {
    if (!newPresence) {
        return;
    }

    const member = newPresence.member;
    if (!member.presence.activities || member.presence.activities.length == 0 || !member.presence.activities.some(a => !!a.applicationId)) {
        // not playing a game
        return;
    }
    newPresence.activities.filter(a => !!a.applicationId).forEach(async activity => {
        // only add if the user doesn't already have the role
        if (member.roles.cache.some(role => role.name === activity.name)) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`"${member.displayName}" already has role "${activity.name}"`);
            }
            return;
        }
        // search for role in cache
        let role = newPresence.guild.roles.cache.find(r => r.name === activity.name);
        if (!role) {
            // fetch new roles from the server
            try {
                role = await newPresence.guild.roles.fetch(roles => {
                    return roles.find(r => r.name === activity.name);
                });
            }
            catch (error) {
                console.error('error while fetching roles:', error);
                return;
            }
        }

        if (!role) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`role "${activity.name}" not found on this server.`);
            }
            return;
        }
        member.roles.add(role).then(() => `role "${role.name}" added to "${member.displayName}"`).catch(reason => {
            console.log(`failed to add role "${role.name}" to "${member.name}"! reason: ${reason}`);
        });
    });
});
client.on('voiceStateUpdate', (oldState, newState) => {
    const newUserChannel = newState.channel;
    const oldUserChannel = oldState.channel;

    if (oldUserChannel !== newUserChannel && newUserChannel !== null) {
        const channelName = `${slugify(newUserChannel.name, { lower: true })}-bot`;
        const foundChannel = newState.guild.channels.cache.find(channel => channel.type === 'GUILD_TEXT' && channel.name === channelName);
        if (foundChannel) {
            foundChannel.permissionOverwrites.create(newState.member, { 'VIEW_CHANNEL': true, 'SEND_MESSAGES': true, 'READ_MESSAGE_HISTORY': true })
                .then(channel => console.log(`added "${newState.member.displayName}" to channel "${channel.name}"`))
                .catch(e => console.log(`failed to add permissions for ${newState.member.displayName}: `, e));
        }
        else {
            newUserChannel.parent.createChannel(channelName, {
                type: 'GUILD_TEXT',
                permissionOverwrites: [
                    {
                        id: client.user.id,
                        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'],
                    },
                    {
                        id: newState.member.id,
                        allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'],
                    },
                    {
                        // @everyone role
                        id: newState.guild.roles.everyone.id,
                        deny: ['VIEW_CHANNEL'],
                    },
                ],
            }).then(channel => {
                console.log(`created channel "${channel.name}" for member "${newState.member.displayName}"`);
            }).catch(e => console.log(`failed to create channel ${channelName}: `, e));
        }
    }
    if (newUserChannel !== oldUserChannel && oldUserChannel !== null) {
        const channelName = `${slugify(oldUserChannel.name, { lower: true })}-bot`;
        const foundChannel = newState.guild.channels.cache.find(channel => channel.type === 'GUILD_TEXT' && channel.name === channelName);
        if (foundChannel) {
            if (oldUserChannel.members.size === 0) {
                foundChannel.delete()
                    .then(channel => console.log(`removed channel "${channel.name}"`))
                    .catch(e => console.log(`failed to delete channel ${channelName}: `, e));
            }
            else {
                foundChannel.permissionOverwrites
                    .delete(newState.member)
                    .then(channel => console.log(`removed "${newState.member.displayName}" from channel "${channel.name}"`))
                    .catch(e => console.log(`failed to remove permissions for ${newState.member.displayName}: `, e));
            }
        }
    }
});