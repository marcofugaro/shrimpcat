import * as THREE from 'three'
import CANNON from 'cannon'
import TWEEN from '@tweenjs/tween.js'
import CannonSphere from 'lib/CannonSphere'
import { getRandomTransparentColor } from 'lib/three-utils'
import { VERTICAL_GAP } from 'scene/Delimiters'

export const PAW_RADIUS = 1
export const FOREARM_HEIGHT = 4
export const FOREARM_WIDTH = 0.9
export const ARM_WIDTH = 1
export const ARM_HEIGHT = 4

export const SPRITE_SIZE = 12

// Y of the rightHinge in a normal position
export const HINGE_REST_Y = -12

// X space between the arms
export const ARMS_SPACE = 7
export const SMACK_DURATION = 500
export const SMACK_SUCCESSFULL_DISTANCE = 1.5
export const SMACK_APERTURE = 3

const debugColor = getRandomTransparentColor()

export default class Arm extends CANNON.Body {
  mesh = new THREE.Object3D()

  constructor({ webgl, ...options }) {
    super(options)
    this.webgl = webgl

    // -1 for right arm, 1 for left arm
    this.way = options.way

    // ADD THE SPRITE
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: options.sprite,
        color: 0xffffff,
        depthTest: false,
        transparent: true,
        opacity: window.DEBUG ? 0.6 : 1,
      }),
    )
    sprite.center.x = options.spriteCenter.x
    sprite.center.y = options.spriteCenter.y
    sprite.scale.multiplyScalar(SPRITE_SIZE)
    this.mesh.add(sprite)

    // ADD THE SHAPES
    // ⚠️ Warning! order of creation is important!
    const hand = new CANNON.Sphere(PAW_RADIUS)
    this.addShape(hand, new CANNON.Vec3(0, 0, 0))

    const forearm = new CANNON.Cylinder(FOREARM_WIDTH, FOREARM_WIDTH, FOREARM_HEIGHT, 32)
    this.addShape(
      forearm,
      new CANNON.Vec3(0.2, -FOREARM_HEIGHT / 2, 0),
      new CANNON.Quaternion().setFromEuler(0, 0, THREE.Math.degToRad(7)),
    )

    const arm = new CANNON.Cylinder(ARM_WIDTH, ARM_WIDTH, ARM_HEIGHT, 32)
    this.addShape(
      arm,
      new CANNON.Vec3(0.9, -(ARM_HEIGHT / 2 + ARM_HEIGHT) * 0.98, 0),
      new CANNON.Quaternion().setFromEuler(0, 0, THREE.Math.degToRad(20)),
    )

    if (window.DEBUG) {
      const handMesh = new THREE.Mesh(
        new THREE.SphereGeometry(hand.radius, 32, 32),
        new THREE.MeshLambertMaterial(debugColor),
      )
      this.mesh.add(handMesh)

      const forearmMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(FOREARM_WIDTH, FOREARM_WIDTH, FOREARM_HEIGHT, 32),
        new THREE.MeshLambertMaterial(debugColor),
      )
      this.mesh.add(forearmMesh)

      const armMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(ARM_WIDTH, ARM_WIDTH, ARM_HEIGHT, 32),
        new THREE.MeshLambertMaterial(debugColor),
      )
      this.mesh.add(armMesh)

      // sync the shapes to their meshes
      let meshIndex = 0
      this.mesh.traverse(child => {
        if (!child.isMesh) {
          return
        }

        const position = this.shapeOffsets[meshIndex]
        const quaternion = this.shapeOrientations[meshIndex]
        child.position.copy(position)
        child.quaternion.copy(quaternion)

        meshIndex++
      })
    }

    // ADD THE HINGE
    this.hinge = new CannonSphere({
      webgl,
      radius: 1,
      mass: 0,
      type: CANNON.Body.DYNAMIC,
      // don't make it collide with anything
      collisionFilterMask: 0,
    })

    // ADD THE ATTRACTOR
    this.attractor = new CannonSphere({
      webgl,
      radius: 0.5,
      mass: 0,
      type: CANNON.Body.DYNAMIC,
      // don't make it collide with anything
      collisionFilterMask: 0,
    })

    // position them
    this.position.set((ARMS_SPACE / 2) * this.way, HINGE_REST_Y + FOREARM_HEIGHT * 1.9, 0)
    if (this.way === 1) {
      this.quaternion.setFromEuler(0, Math.PI, 0)
    }
    this.hinge.position.set((ARMS_SPACE / 2) * this.way, HINGE_REST_Y, 0)
    this.attractor.position.copy(this.position)

    // Connect the arm to the hinge through 2 constraints
    this.webgl.world.addConstraint(
      new CANNON.PointToPointConstraint(
        this,
        new CANNON.Vec3(PAW_RADIUS * 1.5, -FOREARM_HEIGHT * 2, -1),
        this.hinge,
        new CANNON.Vec3(0, 0, this.way),
      ),
    )
    this.webgl.world.addConstraint(
      new CANNON.PointToPointConstraint(
        this,
        new CANNON.Vec3(PAW_RADIUS * 1.5, -FOREARM_HEIGHT * 2, 1),
        this.hinge,
        new CANNON.Vec3(0, 0, -this.way),
      ),
    )

    // setup the springs that will move the arm
    this.spring = new CANNON.Spring(this, this.attractor, {
      localAnchorA: new CANNON.Vec3(),
      localAnchorB: new CANNON.Vec3(),
      restLength: 0,
      stiffness: 120,
      damping: 1,
    })
  }

  update(dt = 0, time = 0) {
    // sync the mesh to the physical body
    this.mesh.position.copy(this.position)
    this.mesh.quaternion.copy(this.quaternion)

    // make the sprite rotation follow the arm
    this.mesh.traverse(child => {
      if (!child.isSprite) {
        return
      }

      // fucking shitty cannon.js,
      // what about using the function's return?
      const eulerRotation = new CANNON.Vec3()
      this.quaternion.toEuler(eulerRotation, 'YZX')

      const zRotation = eulerRotation.z
      child.material.rotation = -zRotation * this.way
    })

    // always attract the arm and sync with its y position
    this.spring.applyForce()
    this.attractor.position.y = this.position.y
  }

  // SMACK!
  smack = clickedPoint => {
    // stop the old animations and attractions
    if (this.attractorTween) this.attractorTween.stop()
    if (this.attractorTweenBack) this.attractorTweenBack.stop()

    this.attractorTween = this.animateAttractor(clickedPoint)
    this.attractorTweenBack = this.moveAttractorBack()
    this.attractorTween = this.attractorTween.start().chain(this.attractorTweenBack)
  }

  // OW!
  leap = clickedPoint => {
    // stop the old animations and attractions
    if (this.hingeTween) this.hingeTween.stop()
    if (this.hingeTweenBack) this.hingeTweenBack.stop()

    this.hingeTween = this.animateArmUp(clickedPoint)
    this.hingeTweenBack = this.animateArmBack()
    this.hingeTween = this.hingeTween.start().chain(this.hingeTweenBack)
  }

  // animate the attractor first one way then the other
  // to simulate the smack
  animateAttractor = clickedPoint => {
    const startX = clickedPoint.x + SMACK_APERTURE * this.way
    const endX = clickedPoint.x - SMACK_APERTURE * this.way

    this.attractor.position.x = startX
    return new TWEEN.Tween(this.attractor.position)
      .to({ x: endX }, SMACK_DURATION)
      .easing(t => (t <= 0.5 ? 0 : 1))
  }

  // reset the arm attractor position
  // to keep the arms in place
  moveAttractorBack = () => {
    const originalStiffness = this.spring.stiffness
    const reducedStiffness = this.spring.stiffness * 0.33333

    // this is a TRICK, basically we want the stiffness
    // to be one third until the end.
    // Better to handle tween js then some setTimeouts.

    const start = () => {
      this.spring.stiffness = reducedStiffness
      this.attractor.position.x = (ARMS_SPACE / 2) * this.way
    }

    const wait = SMACK_DURATION * 0.9

    const end = () => {
      this.spring.stiffness = originalStiffness
    }

    return new TWEEN.Tween({})
      .onStart(start)
      .to({}, wait)
      .onComplete(end)
      .onStop(end)
  }

  // go forward arm!
  animateArmUp = clickedPoint => {
    return new TWEEN.Tween(this.hinge.position)
      .to(
        // TODO use a value proportional to the distance between the lickedPoint and the rightHinge
        {
          ...this.hinge.position,
          y: clickedPoint.y - VERTICAL_GAP + Math.abs(clickedPoint.x) * 0.5,
        },
        SMACK_DURATION,
      )
      .easing(TWEEN.Easing.Quadratic.In)
  }

  // arm go back good job!
  animateArmBack = () => {
    return new TWEEN.Tween(this.hinge.position)
      .to({ ...this.hinge.position, y: HINGE_REST_Y }, SMACK_DURATION * 1.5)
      .easing(TWEEN.Easing.Quadratic.Out)
  }
}
