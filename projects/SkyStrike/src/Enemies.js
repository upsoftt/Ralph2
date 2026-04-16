export class Scout {
    constructor(x, y) {
        this.type = 'enemy';
        this.x = x;
        this.y = y;
        this.width = 50;
        this.height = 50;
        this.hp = 2;
        this.speed = 300; // pixels per second
        this.markedForDeletion = false;

        // Sinusoidal movement
        this.sinOffset = Math.random() * Math.PI * 2;
        this.sinAmplitude = 120;
        this.sinFrequency = 2.0;
        this.time = 0;
        this.baseX = x;
    }

    update(dt) {
        this.time += dt;
        this.y += this.speed * dt;
        this.x = this.baseX + Math.sin(this.time * this.sinFrequency + this.sinOffset) * this.sinAmplitude;

        if (this.y > 2000) {
            this.markedForDeletion = true;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);

        const hw = this.width / 2;
        const hh = this.height / 2;

        // Body — red triangle pointing down (enemy faces down)
        ctx.beginPath();
        ctx.moveTo(0, hh);       // nose (pointing down)
        ctx.lineTo(-hw, -hh);    // left wing
        ctx.lineTo(hw, -hh);     // right wing
        ctx.closePath();
        ctx.fillStyle = '#ff2244';
        ctx.fill();

        // Engine glow (top)
        ctx.fillStyle = '#ff9900';
        ctx.fillRect(-6, -hh, 12, 8);

        ctx.restore();
    }
}
