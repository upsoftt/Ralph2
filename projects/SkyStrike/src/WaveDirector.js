import { Scout } from './Enemies.js';
import { ShieldPowerUp, DoubleFirePowerUp, HealPowerUp } from './PowerUps.js';
import Boss from './Boss.js';

const POWERUP_CLASSES = [ShieldPowerUp, DoubleFirePowerUp, HealPowerUp];
const MAX_POWERUPS_ON_SCREEN = 3;
const BOSS_SPAWN_TIME = 60; // seconds

export default class WaveDirector {
    constructor(engine, particleSystem) {
        this.engine = engine;
        this.particleSystem = particleSystem;
        this.type = 'director';
        this.markedForDeletion = false;

        this.spawnInterval = 3.0; // seconds between waves
        this.spawnTimer = 0;

        // Power-up spawning: every 12 ±3 seconds
        this.powerUpInterval = this._nextPowerUpInterval();
        this.powerUpTimer = 0;

        // Boss phase
        this.totalTime = 0;
        this.bossSpawned = false;
    }

    _nextPowerUpInterval() {
        return 12 + (Math.random() * 6 - 3); // 9..15
    }

    update(dt) {
        this.totalTime += dt;

        // Boss phase — stop normal spawning
        if (this.totalTime >= BOSS_SPAWN_TIME) {
            if (!this.bossSpawned) {
                this.bossSpawned = true;
                const boss = new Boss(this.engine, this.particleSystem);
                this.engine.addEntity(boss);
            }
            // Still allow power-up spawning during boss fight
            this._updatePowerUps(dt);
            return;
        }

        // Normal enemy waves
        this.spawnTimer += dt;
        if (this.spawnTimer >= this.spawnInterval) {
            this.spawnTimer = 0;
            this.spawnWave();
        }

        this._updatePowerUps(dt);
    }

    _updatePowerUps(dt) {
        this.powerUpTimer += dt;
        if (this.powerUpTimer >= this.powerUpInterval) {
            this.powerUpTimer = 0;
            this.powerUpInterval = this._nextPowerUpInterval();
            this._spawnPowerUp();
        }
    }

    spawnWave() {
        const margin = 100;
        const spawnY = -100;

        for (let i = 0; i < 3; i++) {
            const x = margin + Math.random() * (this.engine.width - margin * 2);
            this.engine.addEntity(new Scout(x, spawnY));
        }
    }

    _spawnPowerUp() {
        // Count existing power-ups on screen
        const count = this.engine.entities.filter(e => e.type === 'powerup' && !e.markedForDeletion).length;
        if (count >= MAX_POWERUPS_ON_SCREEN) return;

        const margin = 80;
        const x = margin + Math.random() * (this.engine.width - margin * 2);
        const Cls = POWERUP_CLASSES[Math.floor(Math.random() * POWERUP_CLASSES.length)];
        this.engine.addEntity(new Cls(x, -50));
    }

    // No visual representation
    draw() {}
}
