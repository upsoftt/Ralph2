export default class CollisionManager {
    constructor(engine, particleSystem) {
        this.engine = engine;
        this.particleSystem = particleSystem;
        this.type = 'system';
        this.markedForDeletion = false;
        this.victoryDisplayed = false;
        this.gameOverDisplayed = false;
        this.score = 0;
        this.scoreEl = document.getElementById('score');
    }

    update() {
        // Check for game over (player dead)
        if (!this.gameOverDisplayed && !this.victoryDisplayed) {
            const playerAlive = this.engine.entities.some(e => e.type === 'player' && !e.markedForDeletion);
            if (!playerAlive) {
                this.gameOverDisplayed = true;
                this._showGameOver();
                this._stopGame();
                return;
            }
        }

        const entities = this.engine.entities;

        const players = [];
        const enemies = [];
        const playerProjectiles = [];
        const enemyProjectiles = [];
        const powerups = [];

        for (const e of entities) {
            if (e.markedForDeletion) continue;
            if (e.type === 'player') players.push(e);
            else if (e.type === 'enemy') enemies.push(e);
            else if (e.type === 'player_projectile') playerProjectiles.push(e);
            else if (e.type === 'enemy_projectile') enemyProjectiles.push(e);
            else if (e.type === 'powerup') powerups.push(e);
        }

        // player_projectile <-> enemy
        for (const proj of playerProjectiles) {
            if (proj.markedForDeletion) continue;
            for (const enemy of enemies) {
                if (enemy.markedForDeletion) continue;
                if (this._circlesOverlap(proj, enemy)) {
                    proj.markedForDeletion = true;
                    enemy.hp -= 1;
                    if (enemy.hp <= 0) {
                        // Boss has special death handler
                        if (enemy.onDeath) {
                            enemy.onDeath();
                            this._addScore(500);
                            if (!this.victoryDisplayed) {
                                this.victoryDisplayed = true;
                                this._showVictory();
                                this._stopGame();
                            }
                        } else {
                            enemy.markedForDeletion = true;
                            this._addScore(100);
                        }
                        this.particleSystem.spawnExplosion(enemy.x, enemy.y, 20, '#ff6600');
                    } else {
                        this.particleSystem.spawnExplosion(enemy.x, enemy.y, 6, '#ffcc00');
                    }
                    break;
                }
            }
        }

        // player <-> enemy (no ram collision with boss — only projectiles)
        for (const player of players) {
            if (player.markedForDeletion) continue;
            for (const enemy of enemies) {
                if (enemy.markedForDeletion) continue;
                if (this._circlesOverlap(player, enemy)) {
                    // Regular enemies are destroyed on contact; boss is not
                    if (!enemy.onDeath) {
                        enemy.markedForDeletion = true;
                    }
                    this.particleSystem.spawnExplosion(enemy.x, enemy.y, 14, '#ff2244');

                    // Shield absorbs the hit
                    if (player.shieldTimer > 0) {
                        player.shieldTimer = 0;
                        this.particleSystem.spawnExplosion(player.x, player.y, 10, '#00ccff');
                    } else {
                        player.hp -= 1;
                        if (player.hp <= 0) {
                            player.markedForDeletion = true;
                            this.particleSystem.spawnExplosion(player.x, player.y, 40, '#00e5ff');
                        }
                    }
                }
            }
        }

        // enemy_projectile <-> player
        for (const proj of enemyProjectiles) {
            if (proj.markedForDeletion) continue;
            for (const player of players) {
                if (player.markedForDeletion) continue;
                if (this._circlesOverlap(proj, player)) {
                    proj.markedForDeletion = true;

                    if (player.shieldTimer > 0) {
                        player.shieldTimer = 0;
                        this.particleSystem.spawnExplosion(player.x, player.y, 10, '#00ccff');
                    } else {
                        player.hp -= 1;
                        if (player.hp <= 0) {
                            player.markedForDeletion = true;
                            this.particleSystem.spawnExplosion(player.x, player.y, 40, '#00e5ff');
                        }
                    }
                    this.particleSystem.spawnExplosion(proj.x, proj.y, 6, '#ff2244');
                    break;
                }
            }
        }

        // player <-> powerup
        for (const player of players) {
            if (player.markedForDeletion) continue;
            for (const pu of powerups) {
                if (pu.markedForDeletion) continue;
                if (this._circlesOverlap(player, pu)) {
                    pu.markedForDeletion = true;
                    pu.applyTo(player);
                    this.particleSystem.spawnExplosion(pu.x, pu.y, 8, pu.color);
                }
            }
        }
    }

    _addScore(points) {
        this.score += points;
        if (this.scoreEl) {
            this.scoreEl.textContent = `Score: ${this.score}`;
        }
    }

    _stopGame() {
        // Remove all enemies, projectiles, power-ups and the wave director
        for (const e of this.engine.entities) {
            if (e.type === 'enemy' || e.type === 'enemy_projectile' ||
                e.type === 'player_projectile' || e.type === 'powerup' ||
                e.type === 'director') {
                e.markedForDeletion = true;
            }
            // Disable player input
            if (e.type === 'player') {
                e.frozen = true;
            }
        }
    }

    _showEndScreen(title, titleColor, glowColor) {
        const score = this.score;
        const overlay = {
            type: 'system',
            markedForDeletion: false,
            update() {},
            draw(ctx) {
                ctx.save();
                ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                ctx.fillRect(0, 700, 1080, 520);

                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // Title
                ctx.font = 'bold 120px sans-serif';
                ctx.fillStyle = titleColor;
                ctx.shadowColor = glowColor;
                ctx.shadowBlur = 30;
                ctx.fillText(title, 540, 920);

                // Score
                ctx.font = 'bold 48px sans-serif';
                ctx.fillStyle = '#ffffff';
                ctx.shadowBlur = 0;
                ctx.fillText(`Score: ${score}`, 540, 1010);

                // Restart hint
                ctx.font = '36px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.fillText('Press ENTER to restart', 540, 1080);

                ctx.restore();
            }
        };
        this.engine.addEntity(overlay);
        this._enableRestart();
    }

    _showVictory() {
        this._showEndScreen('VICTORY', '#ffcc00', '#ff6600');
    }

    _showGameOver() {
        this._showEndScreen('GAME OVER', '#ff2244', '#ff0000');
    }

    _enableRestart() {
        const handler = (e) => {
            if (e.code === 'Enter') {
                window.removeEventListener('keydown', handler);
                location.reload();
            }
        };
        window.addEventListener('keydown', handler);
    }

    _circlesOverlap(a, b) {
        const ra = (a.width + a.height) / 4;
        const rb = (b.width + b.height) / 4;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy;
        const radSum = ra + rb;
        return dist2 < radSum * radSum;
    }

    draw() {}
}
