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
        
        // ─── CAPTURA A DOBRADIÇA EXCLUSIVA DESTE DISCO ───
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

        // ─── LÓGICA DE FECHAR A CAPA (Sempre tenta fechar se não estiver no meio da Inspeção) ───
        if (this.state !== 'INSPECTING' && this.hinge) {
            // Volta a dobradiça para 0 radianos rapidamente
            this.hinge.rotation.y = THREE.MathUtils.lerp(this.hinge.rotation.y, 0, 0.15);
        }

        if (this.state === 'INSPECTING') {
            // 1. O LEVANTE VERTICAL
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, 25.5, 0.04);
            this.mesh.position.z = THREE.MathUtils.lerp(this.mesh.position.z, this.baseZ, 0.03); 
            
            // 2. O GATILHO DA ROTAÇÃO
            if (25.5 - this.mesh.position.y < 0.8) {
                this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, 0, 0.08);

                // 3. O GATEFOLD ABRE!
                // Se a capa frontal já virou para você (menos de 0.15 radianos de margem), ele escancara.
                if (Math.abs(this.mesh.rotation.y) < 0.15 && this.hinge) {
                    // -2.2 radianos cria uma abertura de quase 130 graus (ajuste se quiser mais ou menos aberto)
                    this.hinge.rotation.y = THREE.MathUtils.lerp(this.hinge.rotation.y, -2.2, 0.06);
                }
            } else {
                this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, this.targetRotY, 0.1);
            }
        }
        else if (this.state === 'RETURNING') {
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, this.baseY, 0.05);
            this.mesh.position.z = THREE.MathUtils.lerp(this.mesh.position.z, this.baseZ, 0.04);
            this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, this.targetRotY, 0.05);

            if (Math.abs(this.mesh.position.y - this.baseY) < 0.1 && Math.abs(this.mesh.position.z - this.baseZ) < 0.1) {
                this.mesh.position.y = this.baseY;
                this.mesh.position.z = this.baseZ;
                this.mesh.rotation.y = this.targetRotY;
                this.state = 'IDLE';
            }
        }
        else if (this.state === 'SINKING') {
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, PROFUNDIDADE_INVISIVEL, 0.05);
        } 
        else {
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