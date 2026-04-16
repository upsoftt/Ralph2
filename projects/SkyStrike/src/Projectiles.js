export class PlayerProjectile {
    constructor(x, y) {
        this.type = 'player_projectile';
        this.x = x;
        this.y = y;
        this.width = 8;
        this.height = 20;
        this.speed = 1200; // pixels per second
        this.markedForDeletion = false;
    }

    update(dt) {
        this.y -= this.speed * dt;

        if (this.y < -50) {
            this.markedForDeletion = true;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);

        // Bullet body
        ctx.fillStyle = '#ffee00';
        ctx.fillRect(-this.width / 2, -this.height / 2, this.width, this.height);

        // Glow tip
        ctx.beginPath();
        ctx.arc(0, -this.height / 2, this.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.restore();
    }
}
