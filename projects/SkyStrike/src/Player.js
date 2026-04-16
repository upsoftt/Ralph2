import { PlayerProjectile } from './Projectiles.js';

export default class Player {
    constructor(engine) {
        this.engine = engine;
        this.type = 'player';
        this.hp = 3;

        // Size and position
        this.width = 60;
        this.height = 80;
        this.x = this.engine.width / 2;
        this.y = this.engine.height - 150;

        // Movement
        this.speed = 500; // pixels per second
        this.markedForDeletion = false;

        // Shooting cooldown (seconds)
        this.baseShootCooldown = 0.15;
        this.shootCooldown = this.baseShootCooldown;
        this.shootTimer = 0;

        // Power-up timers
        this.shieldTimer = 0;
        this.doubleFireTimer = 0;

        this.keys = {
            up: false,
            down: false,
            left: false,
            right: false,
            shoot: false
        };

        this.setupInput();
    }

    setupInput() {
        window.addEventListener('keydown', (e) => {
            if (e.code === 'ArrowUp' || e.code === 'KeyW') this.keys.up = true;
            if (e.code === 'ArrowDown' || e.code === 'KeyS') this.keys.down = true;
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.keys.left = true;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') this.keys.right = true;
            if (e.code === 'Space') this.keys.shoot = true;
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'ArrowUp' || e.code === 'KeyW') this.keys.up = false;
            if (e.code === 'ArrowDown' || e.code === 'KeyS') this.keys.down = false;
            if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.keys.left = false;
            if (e.code === 'ArrowRight' || e.code === 'KeyD') this.keys.right = false;
            if (e.code === 'Space') this.keys.shoot = false;
        });
    }

    update(dt) {
        if (this.frozen) return;

        // Movement logic
        if (this.keys.up) this.y -= this.speed * dt;
        if (this.keys.down) this.y += this.speed * dt;
        if (this.keys.left) this.x -= this.speed * dt;
        if (this.keys.right) this.x += this.speed * dt;

        // Boundary constraints
        if (this.x < this.width / 2) this.x = this.width / 2;
        if (this.x > this.engine.width - this.width / 2) this.x = this.engine.width - this.width / 2;
        if (this.y < this.height / 2) this.y = this.height / 2;
        if (this.y > this.engine.height - this.height / 2) this.y = this.engine.height - this.height / 2;

        // Power-up timers
        if (this.shieldTimer > 0) this.shieldTimer -= dt;
        if (this.doubleFireTimer > 0) {
            this.doubleFireTimer -= dt;
            this.shootCooldown = this.baseShootCooldown / 2;
        } else {
            this.shootCooldown = this.baseShootCooldown;
        }

        // Shooting
        this.shootTimer -= dt;
        if (this.keys.shoot && this.shootTimer <= 0) {
            this.shootTimer = this.shootCooldown;
            this.engine.addEntity(new PlayerProjectile(this.x, this.y - this.height / 2));
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);

        const hw = this.width  / 2;
        const hh = this.height / 2;

        // Main body — cyan triangle pointing up
        ctx.beginPath();
        ctx.moveTo(0,   -hh);   // nose
        ctx.lineTo(-hw,  hh);   // left wing tip
        ctx.lineTo( hw,  hh);   // right wing tip
        ctx.closePath();
        ctx.fillStyle = '#00e5ff';
        ctx.fill();

        // Engine glow
        ctx.fillStyle = '#ff6600';
        ctx.fillRect(-8, hh - 4, 16, 12);

        // Cockpit highlight
        ctx.beginPath();
        ctx.ellipse(0, -hh + 28, 10, 16, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();

        // Shield effect — cyan ring
        if (this.shieldTimer > 0) {
            ctx.beginPath();
            ctx.arc(0, 0, Math.max(hw, hh) + 10, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,229,255,0.6)';
            ctx.lineWidth = 3;
            ctx.stroke();
        }

        ctx.restore();
    }
}
