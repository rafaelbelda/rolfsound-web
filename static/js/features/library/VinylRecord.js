import * as THREE from 'three';

const PROFUNDIDADE_INVISIVEL = -25;

export default class VinylRecord {
    constructor(mesh, dadosOriginais, indice) {
        this.mesh = mesh;
        this.data = dadosOriginais;

        this.state = 'IDLE';
        this.delayFrames = 0;

        this.targetX = 0;
        this.targetRotY = 0;
        this.baseY = 0;
        this.baseZ = 0;   

        this.hoverOffset = 0;

        this.wantsCameraUp = false;

        this.hinge = null;
        this.mesh.traverse(child => {
            if (child.name === 'GatefoldHinge') this.hinge = child;
        });
    }

    reordenar(novoX, novaRotacao, delayRipple) {
        this.targetX = novoX;
        this.targetRotY = novaRotacao;
        if (Math.abs(this.mesh.position.x - novoX) < 0.1) return;
        this.state = 'SINKING';
        this.delayFrames = delayRipple;
    }

    setHover(isHovered) {
        if (this.state !== 'IDLE') {
            this.hoverOffset = 0;
            return;
        }
        this.hoverOffset = isHovered ? 2.5 : 0;
    }

    update() {
        if (this.delayFrames > 0) {
            this.delayFrames--;
            return;
        }

        // Fecha o gatefold sempre que não estiver inspecionando
        if (this.state !== 'INSPECTING' && this.hinge) {
            this.hinge.rotation.y = THREE.MathUtils.lerp(this.hinge.rotation.y, 0, 0.15);
        }

        if (this.state === 'INSPECTING') {
            this.wantsCameraUp = true;

            // 1. Levante vertical
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, 25.5, 0.04);

            // 2. Gatilho da rotação: só gira quando está perto da altura alvo
            if (25.5 - this.mesh.position.y < 0.8) {
                this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, 0, 0.08);

                // 3. Gatefold abre depois que a capa está de frente
                if (Math.abs(this.mesh.rotation.y) < 0.15 && this.hinge) {
                    this.hinge.rotation.y = THREE.MathUtils.lerp(this.hinge.rotation.y, -2.2, 0.06);
                }
            } else {
                this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, this.targetRotY, 0.1);
            }
        }
        else if (this.state === 'RETURNING') {
            // Fix #3 — câmera fica alta durante todo o RETURNING
            this.wantsCameraUp = true;

            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, this.baseY, 0.05);

            this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, this.targetRotY, 0.05);

            const arrivedY = Math.abs(this.mesh.position.y - this.baseY) < 0.1;
            const arrivedZ = Math.abs(this.mesh.position.z - this.baseZ) < 0.1;

            if (arrivedY && arrivedZ) {
                this.mesh.position.y = this.baseY;
                this.mesh.position.z = this.baseZ;
                this.mesh.rotation.y = this.targetRotY;
                // Fix #3 — só libera câmera quando o disco pousou de verdade
                this.wantsCameraUp = false;
                this.state = 'IDLE';
            }
        }
        else if (this.state === 'SINKING') {
            this.wantsCameraUp = false;
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, PROFUNDIDADE_INVISIVEL, 0.05);
        }
        else {
            // IDLE / EMERGING
            this.wantsCameraUp = false;

            const activeHoverOffset = this.state === 'IDLE' ? this.hoverOffset : 0;
            const targetY = this.baseY + activeHoverOffset;
            const inercia = this.state === 'EMERGING' ? 0.035 : 0.15;

            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, targetY, inercia);
            this.mesh.position.z = THREE.MathUtils.lerp(this.mesh.position.z, this.baseZ, inercia);
            this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, this.targetRotY, inercia);

            if (this.state === 'EMERGING' && Math.abs(this.mesh.position.y - this.baseY) < 0.15) {
                this.mesh.position.y = this.baseY;
                this.state = 'IDLE';
            }
        }
    }
}