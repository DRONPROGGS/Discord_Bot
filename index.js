const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');
require('dotenv').config();

const clientId = process.env.Client_Id;
const commands = [
    {
        name: 'add-gravbits',
        description: 'Add this channel for message deletion.',
    },
    {
        name: 'remove-gravbits',
        description: 'Remove this channel from the deletion list.',
    },
    {
        name: 'check-gravbits',
        description: 'Set the interval for message deletion (hours).',
        options: [
            {
                name: 'interval',
                type: 4, // INTEGER
                description: 'Interval in hours (e.g., 24 for 1 day)',
                required: false,
            },
        ],
    },
    {
        name: 'deltime-gravbits',
        description: 'Set the time for messages to be deleted (older than N hours).',
        options: [
            {
                name: 'delete_age',
                type: 4, // INTEGER
                description: 'Delete messages older than N hours',
                required: false,
            },
        ],
    },
    {
        name: 'delete-gravbits',
        description: 'Delete the last 10 messages from the current channel.',
    },
    {
        name: 'status',
        description: 'Show the current settings for all added channels',
    },
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);

// PostgreSQL setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Function to create the `channels` table if it doesn't exist
const createTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS channels (
            guildId TEXT,
            channelId TEXT,
            checkInterval INTEGER,
            deleteTime INTEGER,
            PRIMARY KEY (guildId, channelId)
        );
    `;

    try {
        await pool.query(query);
        console.log('Table created or already exists.');
    } catch (err) {
        console.error('Error creating table:', err);
    }
};

// Initialize Discord bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Function to upsert (insert or update) channel settings
const upsertChannel = async (guildId, channelId, checkInterval, deleteTime) => {
    if (!channelId) {
        console.error('Cannot upsert: channelId is undefined.');
        return;
    }

    const query = `
        INSERT INTO channels (guildId, channelId, checkInterval, deleteTime)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (guildId, channelId) 
        DO UPDATE SET checkInterval = EXCLUDED.checkInterval, deleteTime = EXCLUDED.deleteTime;
    `;

    try {
        await pool.query(query, [guildId, channelId, checkInterval, deleteTime]);
        console.log(`Channel ${channelId} added/updated for guild ${guildId}.`);
    } catch (err) {
        console.error('Error upserting channel:', err.message);
    }
};

// Function to fetch all channels and their settings for a guild
const getChannelsForGuild = async (guildId) => {
    const query = `SELECT channelId, checkInterval, deleteTime FROM channels WHERE guildId = $1`;

    try {
        const result = await pool.query(query, [guildId]);
        return result.rows;
    } catch (err) {
        console.error('Error fetching channels:', err.message);
        return [];
    }
};

// Helper function to fetch a channel name
const fetchChannelName = async (channelId) => {
    if (!channelId) {
        console.error('Cannot fetch channel name: channelId is undefined.');
        return 'Unknown Channel';
    }

    try {
        const channel = await client.channels.fetch(channelId);
        return channel ? channel.name : 'Unknown Channel';
    } catch (error) {
        console.error(`Error fetching channel name for ${channelId}:`, error);
        return 'Unknown Channel';
    }
};

// Register commands for the guild
const registerCommandsForGuild = async (guildId) => {
    try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
            body: commands,
        });
        console.log(`Successfully registered commands for guild: ${guildId}`);
    } catch (error) {
        console.error(error);
    }
};

// Listen for when the bot joins a new guild
client.on('guildCreate', (guild) => {
    console.log(`Joined a new guild: ${guild.name} (ID: ${guild.id})`);
    registerCommandsForGuild(guild.id);
});

// Slash command: Handle interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const guildId = interaction.guildId;
    const { commandName, channelId } = interaction;
    let checkInterval = 24; // Default check interval in hours (1 day)
    let deleteTime = 2160; // Default delete time in hours (3 months)

    if (commandName === 'add-gravbits') {
        await upsertChannel(guildId, channelId, checkInterval, deleteTime);
        await interaction.reply(`Channel ${await fetchChannelName(channelId)} has been added for message deletion.`);
    } else if (commandName === 'remove-gravbits') {
        await removeChannel(guildId, channelId);
        await interaction.reply(`Channel ${await fetchChannelName(channelId)} has been removed from the deletion list.`);
    } else if (commandName === 'check-gravbits') {
        checkInterval = interaction.options.getInteger('interval') || 24; // Use provided interval or default
        await upsertChannel(guildId, channelId, checkInterval, deleteTime);
        await interaction.reply(`Check interval for channel ${await fetchChannelName(channelId)} has been set to ${checkInterval} hours.`);
    } else if (commandName === 'deltime-gravbits') {
        deleteTime = interaction.options.getInteger('delete_age') || 2160; // Use provided delete time or default
        await upsertChannel(guildId, channelId, checkInterval, deleteTime);
        await interaction.reply(`Messages older than ${deleteTime} hours will be deleted in channel ${await fetchChannelName(channelId)}.`);
    } else if (commandName === 'status') {
        const channels = await getChannelsForGuild(guildId);
        if (channels.length === 0) {
            await interaction.reply('No channels found for this guild.');
            return;
        }

        let statusMessage = 'Current Settings:\n';
        for (const row of channels) {
            const channelName = await fetchChannelName(row.channelId);
            statusMessage += `Channel: ${channelName}, Check Interval: ${row.checkInterval}h, Delete messages older than: ${row.deleteTime}h\n`;
        }

        await interaction.reply(statusMessage);
    } else if (commandName === 'delete-gravbits') {
        const messages = await interaction.channel.messages.fetch({ limit: 10 });
        const deletePromises = messages.map(msg => msg.delete());

        await Promise.all(deletePromises);
        await interaction.reply(`Deleted the last 10 messages in this channel.`);
    }
});

// Function to check and delete old messages in all stored channels
const checkOldMessages = async () => {
    const now = Date.now();

    pool.query(`SELECT DISTINCT guildId, channelId, checkInterval, deleteTime FROM channels`, async (err, result) => {
        if (err) {
            console.error('Error fetching channel data:', err.message);
            return;
        }

        for (const row of result.rows) {
            const deleteTimeInMs = row.deleteTime * 60 * 60 * 1000; // Convert hours to milliseconds
            const channel = await client.channels.fetch(row.channelId).catch(console.error);
            if (!channel) {
                console.error(`Channel not found: ${row.channelId}`);
                continue;
            }

            let deletedMessageCount = 0;
            const messages = await channel.messages.fetch({ limit: 100 }).catch(console.error);

            if (messages.size === 0) return;

            const deletePromises = messages.map(async (message) => {
                const messageAge = now - message.createdTimestamp;
                if (messageAge > deleteTimeInMs) {
                    await message.delete();
                    deletedMessageCount++;
                }
            });

            await Promise.all(deletePromises);

            if (deletedMessageCount > 0) {
                await channel.send(`🧹 I have deleted ${deletedMessageCount} messages older than ${row.deleteTime} hours.`);
            } else {
                await channel.send(`🔍 No messages older than ${row.deleteTime} hours were found.`);
            }
        }
    });
};

// Schedule the check to run once per day
setInterval(checkOldMessages, 24 * 60 * 60 * 1000); // 1 day interval

// Create the table at the start if it doesn't exist
createTable().then(() => {
    // Login to Discord bot
    client.login(process.env.DISCORD_TOKEN);
});

