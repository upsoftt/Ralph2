class PowerUp {
    constructor(x, y, color) {
        this.type = 'powerup';
        this.x = x;
        this.y = y;
        this.width = 40;
        this.height = 40;
        this.speed = 150; // px/s falling down
        this.color = color;
        this.markedForDeletion = false;
        this.time = 0; // for animation
    }

    update(dt) {
        this.y += this.speed * dt;
        this.time += dt;
        if (this.y > 2000) {
            this.markedForDeletion = true;
        }
    }

    applyTo(player) {
        // Override in subclasses
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);

        // Pulsating glow
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 4);
        ctx.globalAlpha = pulse;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 12;

        // Colored square
        const half = this.width / 2;
        ctx.fillStyle = this.color;
        ctx.fillRect(-half, -half, this.width, this.height);

        // Inner icon area (white border)
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(-half + 4, -half + 4, this.width - 8, this.height - 8);

        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        // Draw icon specific to subclass
        this._drawIcon(ctx);

        ctx.restore();
    }

    _drawIcon(ctx) {}
}

export class ShieldPowerUp extends PowerUp {
    constructor(x, y) {
        super(x, y, '#00ccff');
        this.powerType = 'shield';
    }

    applyTo(player) {
        player.shieldTimer = 5.0; // 5 seconds
    }

    _drawIcon(ctx) {
        // Shield icon — small circle
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }
}

export class DoubleFirePowerUp extends PowerUp {
    constructor(x, y) {
        super(x, y, '#ff4400');
        this.powerType = 'doubleFire';
    }

    applyTo(player) {
        player.doubleFireTimer = 8.0; // 8 seconds
    }

    _drawIcon(ctx) {
        // Double arrows icon
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-8, -6, 4, 12);
        ctx.fillRect(4, -6, 4, 12);
        // Arrow tips
        ctx.beginPath();
        ctx.moveTo(-6, -6);
        ctx.lineTo(-10, -2);
        ctx.lineTo(-2, -2);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(6, -6);
        ctx.lineTo(2, -2);
        ctx.lineTo(10, -2);
        ctx.closePath();
        ctx.fill();
    }
}

export class HealPowerUp extends PowerUp {
    constructor(x, y) {
        super(x, y, '#00ff66');
        this.powerType = 'heal';
    }

    applyTo(player) {
        if (player.hp < 3) {
            player.hp += 1;
        }
    }

    _drawIcon(ctx) {
        // Cross icon
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-3, -10, 6, 20);
        ctx.fillRect(-10, -3, 20, 6);
    }
}
