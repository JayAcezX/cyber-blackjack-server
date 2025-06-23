// server.js

// Import necessary modules
const express = require('express');
const http = require('http'); // Node.js built-in HTTP module
const { Server } = require('socket.io'); // Socket.IO server class

// Initialize Express app
const app = express();
// Create an HTTP server using Express
const server = http.createServer(app);

// Initialize Socket.IO server
const io = new Server(server, {
    cors: {
        origin: "*", // Allows connections from any origin. For production, restrict this.
        methods: ["GET", "POST"]
    }
});

// --- Server-side Game State & Logic ---

const matchmakingQueue = [];
const activeGames = {};

// Helper function to create a standard 52-card deck
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    return deck;
}

// Helper function to shuffle a deck
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; // Swap elements
    }
    return deck;
}

// Helper function to get the value of a card
function getCardValue(card, currentTotal) {
    if (card.rank === 'A') {
        // Ace is 11 unless it busts the hand, then it's 1
        return (currentTotal + 11 > 21) ? 1 : 11;
    }
    if (['K', 'Q', 'J'].includes(card.rank)) {
        return 10;
    }
    return parseInt(card.rank);
}

// Helper function to calculate hand total
function calculateHandTotal(hand) {
    let total = 0;
    let numAces = 0;
    for (const card of hand) {
        if (card.rank === 'A') {
            numAces++;
        }
        total += getCardValue(card, total); // Pass current total for Ace logic
    }

    // Adjust for Aces if busting
    while (total > 21 && numAces > 0) {
        total -= 10; // Change an Ace from 11 to 1
        numAces--;
    }
    return total;
}

// Function to initialize a new game state for a room
function initializeGame(player1Id, player2Id) {
    const deck = shuffleDeck(createDeck());
    const player1Hand = [];
    const player2Hand = [];
    const dealerHand = [];

    // Deal initial cards (two to each player, two to dealer)
    player1Hand.push(deck.pop());
    player2Hand.push(deck.pop());
    dealerHand.push(deck.pop()); // Dealer's first card (face up)
    player1Hand.push(deck.pop());
    player2Hand.push(deck.pop());
    dealerHand.push(deck.pop()); // Dealer's second card (face down initially)

    return {
        deck,
        players: [player1Id, player2Id],
        [player1Id]: {
            hand: player1Hand,
            score: calculateHandTotal(player1Hand),
            isStanding: false,
            isBusted: false,
            chips: 1000 // Example: starting chips
        },
        [player2Id]: {
            hand: player2Hand,
            score: calculateHandTotal(player2Hand),
            isStanding: false,
            isBusted: false,
            chips: 1000
        },
        dealer: {
            hand: dealerHand,
            score: calculateHandTotal(dealerHand), // Calculate full score but keep second card hidden for client
            isBusted: false
        },
        currentTurn: player1Id, // Player 1 starts
        turnOrder: [player1Id, player2Id, 'dealer'], // Explicit turn order
        turnIndex: 0,
        message: "Game started! Player 1's turn."
    };
}

// Function to get the game state tailored for a specific player
// Hides opponent's second card and dealer's second card
function getGameStateForPlayer(game, playerId) {
    const currentPlayer = game[playerId];
    const opponentId = game.players.find(id => id !== playerId);
    const opponentPlayer = game[opponentId];

    return {
        playerState: {
            id: playerId,
            hand: currentPlayer.hand,
            score: currentPlayer.score,
            isStanding: currentPlayer.isStanding,
            isBusted: currentPlayer.isBusted,
            chips: currentPlayer.chips
        },
        opponentState: {
            id: opponentId,
            hand: opponentPlayer.hand,
            score: opponentPlayer.score, // Opponent's score is visible
            hideFirstCard: false, // In PvP, typically both players' cards are visible to each other once game starts.
                                  // Adjust this logic if you want to hide opponent's second card until showdown.
                                  // For now, let's assume both player hands are fully visible to each other.
            isStanding: opponentPlayer.isStanding,
            isBusted: opponentPlayer.isBusted
        },
        dealerState: {
            hand: [game.dealer.hand[0], { rank: '?', suit: '?' }], // Hide dealer's second card
            score: getCardValue(game.dealer.hand[0], 0), // Only first card's value
            hideSecondCard: true
        },
        currentTurn: game.currentTurn,
        message: game.message,
        gameOver: game.gameOver || false,
        gameOverMessage: game.gameOverMessage || '',
        gameOverType: game.gameOverType || ''
    };
}

// Function to handle a 'hit' action
function handleHit(gameRoomId, playerId) {
    const game = activeGames[gameRoomId];
    if (game.currentTurn !== playerId || game[playerId].isStanding || game[playerId].isBusted) {
        return; // Not their turn, or already stood/busted
    }

    const player = game[playerId];
    const newCard = game.deck.pop();
    player.hand.push(newCard);
    player.score = calculateHandTotal(player.hand);

    if (player.score > 21) {
        player.isBusted = true;
        game.message = `${playerId} busted!`;
        // Move to next turn or end game
        advanceTurn(gameRoomId);
    } else {
        game.message = `${playerId} hits and gets ${newCard.rank} of ${newCard.suit}.`;
    }
}

// Function to handle a 'stand' action
function handleStand(gameRoomId, playerId) {
    const game = activeGames[gameRoomId];
    if (game.currentTurn !== playerId || game[playerId].isStanding || game[playerId].isBusted) {
        return; // Not their turn, or already stood/busted
    }
    game[playerId].isStanding = true;
    game.message = `${playerId} stands.`;
    // Move to next turn
    advanceTurn(gameRoomId);
}

// Function to advance the turn
function advanceTurn(gameRoomId) {
    const game = activeGames[gameRoomId];
    let nextTurnIndex = (game.turnIndex + 1) % game.turnOrder.length;
    let nextPlayerId = game.turnOrder[nextTurnIndex];

    // Skip players who have busted or stood
    while (nextPlayerId !== 'dealer' && (game[nextPlayerId].isBusted || game[nextPlayerId].isStanding)) {
        nextTurnIndex = (nextTurnIndex + 1) % game.turnOrder.length;
        nextPlayerId = game.turnOrder[nextTurnIndex];
    }

    game.turnIndex = nextTurnIndex;
    game.currentTurn = nextPlayerId;

    if (game.currentTurn === 'dealer') {
        // Dealer's turn logic
        handleDealerTurn(gameRoomId);
        determineGameOutcome(gameRoomId); // After dealer plays, determine outcome
    } else {
        game.message = `It's ${game.currentTurn}'s turn.`;
    }
}

// Function to handle dealer's turn
function handleDealerTurn(gameRoomId) {
    const game = activeGames[gameRoomId];
    game.message = "Dealer's turn...";

    // Reveal dealer's hidden card for score calculation
    game.dealer.score = calculateHandTotal(game.dealer.hand);

    // Dealer hits until 17 or more
    while (game.dealer.score < 17) {
        const newCard = game.deck.pop();
        game.dealer.hand.push(newCard);
        game.dealer.score = calculateHandTotal(game.dealer.hand);
        game.message += ` Dealer hits and gets ${newCard.rank} of ${newCard.suit}.`;
    }

    if (game.dealer.score > 21) {
        game.dealer.isBusted = true;
        game.message += " Dealer busts!";
    } else {
        game.message += " Dealer stands.";
    }
}

// Function to determine game outcome (after all players and dealer have acted)
function determineGameOutcome(gameRoomId) {
    const game = activeGames[gameRoomId];
    game.gameOver = true;
    let message = "Round over! ";
    let type = 'info';

    const player1 = game[game.players[0]];
    const player2 = game[game.players[1]];
    const dealer = game.dealer;

    // Determine winner for Player 1
    if (player1.isBusted) {
        message += `${player1.id} busted. `;
    } else if (dealer.isBusted || player1.score > dealer.score) {
        message += `${player1.id} wins! `;
        type = 'win';
    } else if (player1.score < dealer.score) {
        message += `${player1.id} loses. `;
        type = 'lose';
    } else {
        message += `${player1.id} pushes. `; // Push if scores are equal
    }

    // Determine winner for Player 2
    if (player2.isBusted) {
        message += `${player2.id} busted. `;
    } else if (dealer.isBusted || player2.score > dealer.score) {
        message += `${player2.id} wins! `;
        type = 'win'; // This assumes general win type, you might want specific messages per player
    } else if (player2.score < dealer.score) {
        message += `${player2.id} loses. `;
        type = 'lose';
    } else {
        message += `${player2.id} pushes. `;
    }

    game.gameOverMessage = message;
    game.gameOverType = type; // You might need to refine this to show per-player results

    // You might also want to handle chip updates here based on wins/losses
}


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Handle 'requestMatch' event from client
    socket.on('requestMatch', () => {
        console.log(`Match request from: ${socket.id}`);
        matchmakingQueue.push(socket.id); // Add player to queue

        // Simple matchmaking: pair the first two players in the queue
        if (matchmakingQueue.length >= 2) {
            const player1Id = matchmakingQueue.shift();
            const player2Id = matchmakingQueue.shift();

            const gameRoomId = `game-${player1Id}-${player2Id}`;

            io.sockets.sockets.get(player1Id).join(gameRoomId);
            io.sockets.sockets.get(player2Id).join(gameRoomId);

            console.log(`Match found! ${player1Id} vs ${player2Id} in room ${gameRoomId}`);

            // Initialize the actual game state
            const newGame = initializeGame(player1Id, player2Id);
            activeGames[gameRoomId] = newGame;

            // Notify players that a match is found
            io.to(player1Id).emit('matchFound', player2Id);
            io.to(player2Id).emit('matchFound', player1Id);

            // Send initial game state to both players
            // Each player gets a slightly different view (e.g., dealer's second card hidden)
            io.to(player1Id).emit('pvpGameUpdate', getGameStateForPlayer(newGame, player1Id));
            io.to(player2Id).emit('pvpGameUpdate', getGameStateForPlayer(newGame, player2Id));

        } else {
            // Optional: Notify client if no immediate match
            // socket.emit('noMatch'); // You might want a timeout before sending this
        }
    });

    socket.on('cancelMatchmaking', () => {
        const index = matchmakingQueue.indexOf(socket.id);
        if (index > -1) {
            matchmakingQueue.splice(index, 1);
            console.log(`User ${socket.id} cancelled matchmaking.`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const index = matchmakingQueue.indexOf(socket.id);
        if (index > -1) {
            matchmakingQueue.splice(index, 1);
        }

        for (const roomId in activeGames) {
            const game = activeGames[roomId];
            if (game.players.includes(socket.id)) {
                const remainingPlayerId = game.players.find(id => id !== socket.id);
                if (remainingPlayerId) {
                    io.to(remainingPlayerId).emit('pvpGameOver', {
                        message: 'Opponent disconnected. You win!',
                        type: 'win'
                    });
                }
                delete activeGames[roomId];
                console.log(`Game ${roomId} ended due to disconnect.`);
                break;
            }
        }
    });

    // --- New Game Action Handlers ---
    socket.on('playerAction', (data) => {
        const gameRoomId = Object.keys(socket.rooms).find(room => room.startsWith('game-'));
        if (!gameRoomId || !activeGames[gameRoomId]) {
            console.warn(`Action received for unknown or ended game: ${gameRoomId}`);
            return;
        }

        const game = activeGames[gameRoomId];
        const playerId = socket.id;

        if (game.currentTurn !== playerId) {
            // It's not this player's turn, ignore action or send error back
            socket.emit('pvpGameUpdate', { message: "It's not your turn!", messageType: 'error' });
            return;
        }

        switch (data.action) {
            case 'hit':
                handleHit(gameRoomId, playerId);
                break;
            case 'stand':
                handleStand(gameRoomId, playerId);
                break;
            // You can add 'doubleDown', 'split', 'surrender' here
            default:
                console.warn(`Unknown action: ${data.action}`);
                break;
        }

        // After every action, broadcast the updated state to all players in the room
        // Each player gets their specific view of the game state
        io.to(game.players[0]).emit('pvpGameUpdate', getGameStateForPlayer(game, game.players[0]));
        io.to(game.players[1]).emit('pvpGameUpdate', getGameStateForPlayer(game, game.players[1]));

        // If the game is over, explicitly send the game over message after the final state update
        if (game.gameOver) {
            io.to(gameRoomId).emit('pvpGameOver', {
                message: game.gameOverMessage,
                type: game.gameOverType,
                finalGame: getGameStateForPlayer(game, game.players[0]) // Send final state unmasked
            });
            // Consider a mechanism to start a new round or return to lobby here
        }
    });
});

// Serve your client-side files
app.use(express.static('public'));

// Define the port the server will listen on
const PORT = process.env.PORT || 3000;

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access client at http://localhost:${PORT}`);
});