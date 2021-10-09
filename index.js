require('dotenv').config();
const { Client, Intents } = require('discord.js');
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_PRESENCES, Intents.FLAGS.GUILD_MEMBERS] });

client.login(process.env.BOT_TOKEN);
client.on('ready', async () => {
    await Promise.all(client.guilds.cache.map(async g => {
        return g.roles.fetch().then(roles => console.log(`fetched ${roles.size} roles for ${g.name}`));
    }));
    console.log('------------Bot is ready------------');
});
client.on('messageCreate', msg => {
    if (msg.content === 'marco') {
        console.log(
            msg.guild.roles.cache.find(role => role.name === 'osu!'),
        );
    }
});
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
                console.log(`"${member.nickname}" already has role "${activity.name}"`);
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
        member.roles.add(role).then(() => `role "${role.name}" added to "${member.nickname}"`).catch(reason => {
            console.log(`failed to add role "${role.name}" to "${member.name}"! reason: ${reason}`);
        });
    });
});