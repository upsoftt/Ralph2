import Engine from './Engine.js';
import Player from './Player.js';
import WaveDirector from './WaveDirector.js';
import CollisionManager from './CollisionManager.js';
import ParticleSystem from './ParticleSystem.js';

window.addEventListener('load', () => {
    const engine = new Engine('gameCanvas');

    // Initialize player
    const player = new Player(engine);
    engine.addEntity(player);

    // Initialize particle system (visual effects)
    const particleSystem = new ParticleSystem();
    engine.addEntity(particleSystem);

    // Initialize wave director (spawns enemies every 3 seconds, boss at 60s)
    const waveDirector = new WaveDirector(engine, particleSystem);
    engine.addEntity(waveDirector);

    // Initialize collision manager (strict type-based collision matrix)
    const collisionManager = new CollisionManager(engine, particleSystem);
    engine.addEntity(collisionManager);

    engine.start();

    // HUD: update HP display each frame
    const hpEl = document.getElementById('hp');
    (function hudLoop() {
        if (hpEl) {
            hpEl.textContent = player.markedForDeletion
                ? 'HP: DEAD'
                : `HP: ${player.hp}`;
        }
        requestAnimationFrame(hudLoop);
    })();

    // [QA] Log FPS after 3 seconds
    setTimeout(() => {
        console.log(`[QA] FPS after 3 seconds: ${engine.fps}`);
    }, 3000);

    // [QA] Log entities.length every 10 seconds to verify memory cleanup
    setInterval(() => {
        console.log(`[QA] entities.length = ${engine.entities.length} | particles = ${particleSystem.particles.length}`);
    }, 10000);
});
