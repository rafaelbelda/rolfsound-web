// static/js/VinylRecord.js
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
        
        // NOVO: Controle de altura (Eixo Y) para o Hover magnético
        this.hoverOffset = 0; 
    }

    reordenar(novoX, novaRotacao, delayRipple) {
        this.targetX = novoX;
        this.targetRotY = novaRotacao;
        
        if (Math.abs(this.mesh.position.x - novoX) < 0.1) return;

        this.state = 'SINKING';
        this.delayFrames = delayRipple; 
    }

    setHover(isHovered) {
        // Só permite o disco saltar se ele estiver quietinho na prateleira
        if (this.state !== 'IDLE') {
            this.hoverOffset = 0;
            return;
        }
        // Eixo Y: Salta 2.5 unidades para cima quando o mouse passa
        this.hoverOffset = isHovered ? 2.5 : 0; 
    }

    update() {
        if (this.delayFrames > 0) {
            this.delayFrames--;
            return;
        }

        if (this.state === 'SINKING') {
            // Afunda para as sombras
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, PROFUNDIDADE_INVISIVEL, 0.05);
            
            if (this.mesh.position.y < PROFUNDIDADE_INVISIVEL + 1) {
                this.mesh.position.x = this.targetX;
                this.mesh.rotation.y = this.targetRotY;
                this.state = 'EMERGING';
            }
        } 
        else {
            // Se está EMERGING ou IDLE, o alvo no eixo Y é a base natural SOMADA ao pulo do Hover
            const targetY = this.baseY + this.hoverOffset;
            
            // Inércia dinâmica: Se estiver emergindo do filtro, sobe bem devagar (0.035). 
            // Se for apenas o reflexo do mouse (hover), salta rápido e responsivo (0.15)
            const inercia = this.state === 'EMERGING' ? 0.035 : 0.15;
            
            this.mesh.position.y = THREE.MathUtils.lerp(this.mesh.position.y, targetY, inercia);
            
            // Quando terminar de emergir da profundidade, destrava o estado para permitir Hovers novamente
            if (this.state === 'EMERGING' && this.mesh.position.y > this.baseY - 0.1) {
                this.state = 'IDLE';
            }
        }
    }
}