const MAX_PARTICLES = 500;

class Particle {
    constructor(x, y, color) {
        this.x = x;
        this.y = y;
        const angle = Math.random() * Math.PI * 2;
        const speed = 80 + Math.random() * 320;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.gravity = 400;
        this.life = 0.4 + Math.random() * 0.4; // seconds
        this.maxLife = this.life;
        this.size = 3 + Math.random() * 5;
        this.color = color;
        this.dead = false;
    }

    update(dt) {
        this.vy += this.gravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.life -= dt;
        if (this.life <= 0) this.dead = true;
    }

    draw(ctx) {
        const alpha = Math.max(0, this.life / this.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
        ctx.restore();
    }
}

export default class ParticleSystem {
    constructor() {
        this.type = 'system';
        this.markedForDeletion = false;
        this.particles = [];
    }

    spawnExplosion(x, y, count = 18, color = '#ff6600') {
        const colors = [color, '#ffcc00', '#ff2244', '#ffffff'];
        for (let i = 0; i < count; i++) {
            if (this.particles.length >= MAX_PARTICLES) {
                // Replace oldest particle
                this.particles.shift();
            }
            const c = colors[Math.floor(Math.random() * colors.length)];
            this.particles.push(new Particle(x, y, c));
        }
    }

    update(dt) {
        for (const p of this.particles) {
            p.update(dt);
        }
        // Remove dead particles
        this.particles = this.particles.filter(p => !p.dead);
    }

    draw(ctx) {
        for (const p of this.particles) {
            p.draw(ctx);
        }
    }
}
