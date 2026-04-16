const MAX_BOSS_PROJECTILES = 50;

class BossProjectile {
    constructor(x, y, vx, vy) {
        this.type = 'enemy_projectile';
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.width = 14;
        this.height = 14;
        this.markedForDeletion = false;
    }

    update(dt) {
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // Off-screen cleanup
        if (this.y > 2050 || this.y < -100 || this.x < -100 || this.x > 1180) {
            this.markedForDeletion = true;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.beginPath();
        ctx.arc(0, 0, this.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ff2244';
        ctx.shadowColor = '#ff2244';
        ctx.shadowBlur = 8;
        ctx.fill();
        // Inner core
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
    }
}

export default class Boss {
    constructor(engine, particleSystem) {
        this.engine = engine;
        this.particleSystem = particleSystem;
        this.type = 'enemy';
        this.hp = 30;
        this.maxHp = 30;

        this.width = 200;
        this.height = 160;
        this.x = engine.width / 2;
        this.y = -200; // Start off-screen
        this.targetY = 300;
        this.entrySpeed = 120; // px/s during entry
        this.entered = false;

        // Horizontal sinusoidal movement
        this.baseX = engine.width / 2;
        this.sineAmplitude = 80;
        this.sineSpeed = 1.2;
        this.sineTime = 0;

        this.markedForDeletion = false;

        // Attack timers
        this.volleyTimer = 0;
        this.volleyInterval = 1.5;

        this.circularTimer = 0;
        this.circularInterval = 4.0;

        this.missileTimer = 0;
        this.missileInterval = 6.0;

        // Victory state
        this.defeated = false;
        this.victoryTimer = 0;
    }

    update(dt) {
        if (this.defeated) {
            this.victoryTimer += dt;
            return;
        }

        // Entry phase — descend to targetY
        if (!this.entered) {
            this.y += this.entrySpeed * dt;
            if (this.y >= this.targetY) {
                this.y = this.targetY;
                this.entered = true;
                this.baseX = this.x;
            }
            return;
        }

        // Horizontal sinusoidal movement
        this.sineTime += dt;
        this.x = this.baseX + Math.sin(this.sineTime * this.sineSpeed) * this.sineAmplitude;

        // Attack logic
        this._updateAttacks(dt);
    }

    _updateAttacks(dt) {
        // Count existing boss projectiles
        const projCount = this.engine.entities.filter(
            e => e.type === 'enemy_projectile' && !e.markedForDeletion
        ).length;

        // 1) Direct volley — 3 projectiles in a fan downward
        this.volleyTimer += dt;
        if (this.volleyTimer >= this.volleyInterval) {
            this.volleyTimer = 0;
            if (projCount < MAX_BOSS_PROJECTILES) {
                this._fireVolley();
            }
        }

        // 2) Circular barrage — 8 projectiles 360°
        this.circularTimer += dt;
        if (this.circularTimer >= this.circularInterval) {
            this.circularTimer = 0;
            if (projCount < MAX_BOSS_PROJECTILES) {
                this._fireCircular();
            }
        }

        // 3) Aimed missile — one projectile toward player
        this.missileTimer += dt;
        if (this.missileTimer >= this.missileInterval) {
            this.missileTimer = 0;
            if (projCount < MAX_BOSS_PROJECTILES) {
                this._fireMissile();
            }
        }
    }

    _fireVolley() {
        const speed = 500;
        const angles = [-0.3, 0, 0.3]; // fan spread
        for (const offset of angles) {
            const vx = Math.sin(offset) * speed;
            const vy = Math.cos(offset) * speed; // downward
            this.engine.addEntity(
                new BossProjectile(this.x, this.y + this.height / 2, vx, vy)
            );
        }
    }

    _fireCircular() {
        const speed = 350;
        const count = 8;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 / count) * i;
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            this.engine.addEntity(
                new BossProjectile(this.x, this.y, vx, vy)
            );
        }
    }

    _fireMissile() {
        const player = this.engine.entities.find(
            e => e.type === 'player' && !e.markedForDeletion
        );
        if (!player) return;

        const dx = player.x - this.x;
        const dy = player.y - this.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const speed = 450;
        this.engine.addEntity(
            new BossProjectile(this.x, this.y + this.height / 2, (dx / dist) * speed, (dy / dist) * speed)
        );
    }

    onDeath() {
        this.defeated = true;
        this.markedForDeletion = true;
        // Massive explosion
        if (this.particleSystem) {
            for (let i = 0; i < 5; i++) {
                const ox = (Math.random() - 0.5) * this.width;
                const oy = (Math.random() - 0.5) * this.height;
                this.particleSystem.spawnExplosion(this.x + ox, this.y + oy, 30, '#ff6600');
            }
        }
    }

    draw(ctx) {
        if (this.defeated) return;

        ctx.save();
        ctx.translate(this.x, this.y);

        const hw = this.width / 2;
        const hh = this.height / 2;

        // Main hull — dark grey armored body
        ctx.fillStyle = '#3a3a4a';
        ctx.beginPath();
        ctx.moveTo(0, -hh);            // nose
        ctx.lineTo(-hw, hh * 0.4);     // left shoulder
        ctx.lineTo(-hw * 0.7, hh);     // left rear
        ctx.lineTo(hw * 0.7, hh);      // right rear
        ctx.lineTo(hw, hh * 0.4);      // right shoulder
        ctx.closePath();
        ctx.fill();

        // Armor plates
        ctx.fillStyle = '#555570';
        ctx.fillRect(-hw * 0.6, -hh * 0.3, hw * 1.2, hh * 0.5);

        // Left engine
        ctx.fillStyle = '#ff4400';
        ctx.fillRect(-hw * 0.55, hh * 0.6, 20, 24);
        // Right engine
        ctx.fillRect(hw * 0.55 - 20, hh * 0.6, 20, 24);

        // Bridge / cockpit
        ctx.fillStyle = '#ff2244';
        ctx.beginPath();
        ctx.ellipse(0, -hh * 0.15, 22, 16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.ellipse(0, -hh * 0.2, 12, 8, 0, 0, Math.PI * 2);
        ctx.fill();

        // Turret markers (left, center, right)
        ctx.fillStyle = '#ffcc00';
        ctx.fillRect(-hw * 0.5, hh * 0.2, 10, 10);
        ctx.fillRect(-5, hh * 0.35, 10, 10);
        ctx.fillRect(hw * 0.5 - 10, hh * 0.2, 10, 10);

        // HP bar above boss
        const barW = this.width * 0.8;
        const barH = 8;
        const barY = -hh - 20;
        ctx.fillStyle = '#333';
        ctx.fillRect(-barW / 2, barY, barW, barH);
        const ratio = Math.max(0, this.hp / this.maxHp);
        ctx.fillStyle = ratio > 0.3 ? '#ff2244' : '#ff0000';
        ctx.fillRect(-barW / 2, barY, barW * ratio, barH);

        ctx.restore();
    }
}
