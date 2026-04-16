export default class Engine {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.entities = [];
        this.lastTime = 0;
        this.fps = 0;
        this.frameCount = 0;
        this.fpsTimer = 0;
        this.isRunning = false;
        
        // Logical resolution
        this.width = 1080;
        this.height = 1920;
    }

    start() {
        this.isRunning = true;
        this.lastTime = performance.now();
        requestAnimationFrame((time) => this.loop(time));
    }

    stop() {
        this.isRunning = false;
    }

    addEntity(entity) {
        this.entities.push(entity);
    }

    loop(currentTime) {
        if (!this.isRunning) return;

        let dt = (currentTime - this.lastTime) / 1000; // in seconds
        this.lastTime = currentTime;

        // Cap deltaTime to avoid physics bugs on tab switching (max 0.1s)
        if (dt > 0.1) dt = 0.1;

        // FPS calculation
        this.frameCount++;
        this.fpsTimer += dt;
        if (this.fpsTimer >= 1.0) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.fpsTimer = 0;
        }

        this.update(dt);
        this.draw();

        requestAnimationFrame((time) => this.loop(time));
    }

    update(dt) {
        // Snapshot to prevent newly spawned entities from updating in the same tick
        const snapshot = this.entities.slice();
        for (const entity of snapshot) {
            if (entity.update) {
                entity.update(dt);
            }
        }

        // Remove deleted entities
        this.entities = this.entities.filter(entity => !entity.markedForDeletion);
    }

    draw() {
        // Clear canvas
        this.ctx.fillStyle = '#111';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw all entities
        for (const entity of this.entities) {
            if (entity.draw) {
                entity.draw(this.ctx);
            }
        }
    }
}
