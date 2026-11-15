//! Native physics core (Rapier) — deterministic rigid-body simulation for
//! Play mode. Stateful worlds live behind numeric handles; the editor drives
//! them with `physics_step` and receives world-space body states back.
use crate::error::LovaError;
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Shared simulation state (thread-safe across the loop threads).
pub type SharedPhysics = Arc<Mutex<PhysicsState>>;

/// Event channel streaming simulation states to the frontend.
pub const PHYSICS_EVENT: &str = "lova://physics-states";

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "kind")]
pub enum ShapeDesc {
    Ball { radius: f32 },
    Cuboid { hx: f32, hy: f32, hz: f32 },
    Halfspace,
    Cylinder { half_height: f32, radius: f32 },
    Capsule { half_height: f32, radius: f32 },
}

#[derive(Deserialize, Debug, Clone)]
pub struct BodyDesc {
    pub id: String,
    pub dynamic: bool,
    pub shape: ShapeDesc,
    pub translation: [f32; 3],
    #[serde(default)]
    pub linvel: [f32; 3],
    #[serde(default)]
    pub restitution: f32,
    #[serde(default = "default_friction")]
    pub friction: f32,
}

fn default_friction() -> f32 {
    0.6
}

#[derive(Serialize, Debug, Clone)]
pub struct BodyState {
    pub id: String,
    pub translation: [f32; 3],
    pub linvel: [f32; 3],
    pub grounded: bool,
}

struct PhysicsWorld {
    pipeline: PhysicsPipeline,
    gravity: Vector<f32>,
    integration: IntegrationParameters,
    islands: IslandManager,
    broad: BroadPhaseMultiSap,
    narrow: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd: CCDSolver,
    /// Our object id → rigid-body handle (dynamic bodies only are reported).
    handles: HashMap<String, RigidBodyHandle>,
    /// States returned by the most recent step (for determinism tests).
    last_states: Vec<BodyState>,
}

impl PhysicsWorld {
    fn new(bodies_in: Vec<BodyDesc>) -> Self {
        let mut world = Self {
            pipeline: PhysicsPipeline::new(),
            gravity: vector![0.0, -9.81, 0.0],
            integration: IntegrationParameters::default(),
            islands: IslandManager::new(),
            broad: BroadPhaseMultiSap::new(),
            narrow: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            handles: HashMap::new(),
            last_states: Vec::new(),
        };
        for desc in bodies_in {
            world.add_body(desc);
        }
        world
    }

    fn add_body(&mut self, desc: BodyDesc) {
        let shape = match desc.shape {
            ShapeDesc::Ball { radius } => ColliderBuilder::ball(radius.max(0.01)),
            ShapeDesc::Cuboid { hx, hy, hz } => {
                ColliderBuilder::cuboid(hx.max(0.01), hy.max(0.01), hz.max(0.01))
            }
            ShapeDesc::Halfspace => ColliderBuilder::halfspace(nalgebra::Unit::new_normalize(vector![0.0, 1.0, 0.0])),
            ShapeDesc::Cylinder { half_height, radius } => {
                ColliderBuilder::cylinder(half_height.max(0.01), radius.max(0.01))
            }
            ShapeDesc::Capsule { half_height, radius } => {
                ColliderBuilder::capsule_y(half_height.max(0.01), radius.max(0.01))
            }
        }
        .restitution(desc.restitution.clamp(0.0, 1.0))
        .friction(desc.friction.max(0.0));

        let builder = if desc.dynamic {
            RigidBodyBuilder::dynamic()
                .translation(vector![desc.translation[0], desc.translation[1], desc.translation[2]])
                .linvel(vector![desc.linvel[0], desc.linvel[1], desc.linvel[2]])
                // The editor animates orientation itself (spin behavior);
                // Rapier owns translation only.
                .lock_rotations()
                .ccd_enabled(true)
        } else {
            RigidBodyBuilder::fixed()
                .translation(vector![desc.translation[0], desc.translation[1], desc.translation[2]])
        };
        let handle = self.bodies.insert(builder);
        self.colliders.insert_with_parent(shape, handle, &mut self.bodies);
        if desc.dynamic {
            self.handles.insert(desc.id, handle);
        }
    }

    fn step(&mut self, dt: f32) -> Vec<BodyState> {
        let states = self.step_inner(dt);
        self.last_states = states.clone();
        states
    }

    fn last_states(&self) -> Vec<BodyState> {
        self.last_states.clone()
    }

    fn step_inner(&mut self, dt: f32) -> Vec<BodyState> {
        self.integration.dt = dt.clamp(1.0 / 240.0, 0.1);
        self.pipeline.step(
            &self.gravity,
            &self.integration,
            &mut self.islands,
            &mut self.broad,
            &mut self.narrow,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd,
            None,
            &(),
            &(),
        );

        // Grounded: a contact whose normal points "up" for the body. All our
        // bodies have identity rotation (rotations are editor-owned), so the
        // manifold's local normal already equals the world normal. The normal
        // points from collider1 toward collider2.
        let mut grounded: HashMap<String, bool> = HashMap::new();
        let by_handle: HashMap<RigidBodyHandle, &String> =
            self.handles.iter().map(|(id, h)| (*h, id)).collect();
        for pair in self.narrow.contact_pairs() {
            let parent1 = self.colliders.get(pair.collider1).and_then(|c| c.parent());
            let parent2 = self.colliders.get(pair.collider2).and_then(|c| c.parent());
            for manifold in pair.manifolds.iter() {
                let above = if manifold.local_n1.y > 0.5 {
                    parent2
                } else if manifold.local_n1.y < -0.5 {
                    parent1
                } else {
                    continue;
                };
                if let Some(id) = above.and_then(|h| by_handle.get(&h)) {
                    grounded.insert((*id).clone(), true);
                }
            }
        }

        let mut out = Vec::with_capacity(self.handles.len());
        for (id, handle) in &self.handles {
            let Some(body) = self.bodies.get(*handle) else { continue };
            let t = body.translation();
            let v = body.linvel();
            out.push(BodyState {
                id: id.clone(),
                translation: [t.x, t.y, t.z],
                linvel: [v.x, v.y, v.z],
                grounded: grounded.get(id).copied().unwrap_or(false),
            });
        }
        out
    }
}

/// Loop-thread control flags per running world.
#[derive(Clone)]
struct LoopFlags {
    /// true → the thread keeps existing (false exits it; used by destroy).
    stop: Arc<AtomicBool>,
    /// true → the loop idles without stepping (editor pause).
    paused: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PhysicsState {
    worlds: HashMap<u64, PhysicsWorld>,
    next_id: u64,
    /// Control flags for the simulation loop threads.
    running: HashMap<u64, LoopFlags>,
}

fn with_world<T>(
    state: &SharedPhysics,
    world_id: u64,
    f: impl FnOnce(&mut PhysicsWorld) -> T,
) -> Result<T, LovaError> {
    let mut guard = state.lock().map_err(|_| LovaError::io("physics state poisoned"))?;
    guard
        .worlds
        .get_mut(&world_id)
        .map(f)
        .ok_or_else(|| LovaError::io(format!("unknown physics world {world_id}")))
}

#[tauri::command]
pub fn physics_world_create(state: State<'_, SharedPhysics>, bodies: Vec<BodyDesc>) -> Result<u64, LovaError> {
    let mut guard = state.lock().map_err(|_| LovaError::io("physics state poisoned"))?;
    guard.next_id += 1;
    let id = guard.next_id;
    guard.worlds.insert(id, PhysicsWorld::new(bodies));
    Ok(id)
}

#[tauri::command]
pub fn physics_step(state: State<'_, SharedPhysics>, world: u64, dt: f32) -> Result<Vec<BodyState>, LovaError> {
    with_world(&state, world, |w| w.step(dt))
}

#[tauri::command]
pub fn physics_set_velocity(
    state: State<'_, SharedPhysics>,
    world: u64,
    id: String,
    linvel: [f32; 3],
) -> Result<(), LovaError> {
    with_world(&state, world, |w| {
        if let Some(&handle) = w.handles.get(&id) {
            if let Some(body) = w.bodies.get_mut(handle) {
                body.set_linvel(vector![linvel[0], linvel[1], linvel[2]], true);
            }
        }
    })
}

#[tauri::command]
pub fn physics_teleport(
    state: State<'_, SharedPhysics>,
    world: u64,
    id: String,
    translation: [f32; 3],
) -> Result<(), LovaError> {
    with_world(&state, world, |w| {
        if let Some(&handle) = w.handles.get(&id) {
            if let Some(body) = w.bodies.get_mut(handle) {
                body.set_translation(vector![translation[0], translation[1], translation[2]], true);
            }
        }
    })
}

#[derive(Serialize, Clone)]
struct PhysicsEvent {
    world: u64,
    states: Vec<BodyState>,
}

/// Runs the simulation loop inside Rust on its own thread at a fixed
/// timestep, streaming states back via `lova://physics-states`. The frontend
/// becomes a pure view — no per-frame IPC round-trips.
#[tauri::command]
pub fn physics_run(app: AppHandle, state: State<'_, SharedPhysics>, world: u64, hz: f32) -> Result<(), LovaError> {
    let flags = {
        let mut guard = state.lock().map_err(|_| LovaError::io("physics state poisoned"))?;
        guard.worlds.get(&world).ok_or_else(|| LovaError::io(format!("unknown physics world {world}")))?;
        let flags = LoopFlags {
            stop: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
        };
        guard.running.insert(world, flags.clone());
        flags
    };
    let hz = hz.clamp(10.0, 240.0);
    let dt = 1.0 / hz;
    let state_ref: SharedPhysics = Arc::clone(state.inner());

    std::thread::spawn(move || {
        let mut next_tick = Instant::now();
        loop {
            if flags.stop.load(Ordering::Relaxed) {
                break;
            }
            if !flags.paused.load(Ordering::Relaxed) {
                let tick_result = with_world(&state_ref, world, |w| w.step(dt));
                match tick_result {
                    Ok(states) => {
                        let _ = app.emit(PHYSICS_EVENT, PhysicsEvent { world, states });
                    }
                    Err(_) => break, // world destroyed
                }
            }
            // Fixed-timestep pacing: sleep until the next tick, catch up if late.
            next_tick += Duration::from_secs_f32(dt);
            let now = Instant::now();
            if next_tick > now {
                std::thread::sleep(next_tick - now);
            } else {
                next_tick = now; // fell behind — don't burst
            }
        }
    });
    Ok(())
}

/// Pause/resume a running simulation loop (used by editor pause). The loop
/// thread keeps pacing but skips stepping while paused.
#[tauri::command]
pub fn physics_set_running(state: State<'_, SharedPhysics>, world: u64, running: bool) -> Result<(), LovaError> {
    let guard = state.lock().map_err(|_| LovaError::io("physics state poisoned"))?;
    match guard.running.get(&world) {
        Some(flags) => {
            flags.paused.store(!running, Ordering::Relaxed);
            Ok(())
        }
        None => Err(LovaError::io(format!("physics world {world} is not running"))),
    }
}

#[tauri::command]
pub fn physics_world_destroy(state: State<'_, SharedPhysics>, world: u64) -> bool {
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    // Signal the loop thread (if any) to stop before dropping the world.
    if let Some(flags) = guard.running.remove(&world) {
        flags.stop.store(true, Ordering::Relaxed);
    }
    guard.worlds.remove(&world).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ground() -> BodyDesc {
        BodyDesc {
            id: "ground".into(),
            dynamic: false,
            shape: ShapeDesc::Halfspace,
            translation: [0.0, 0.0, 0.0],
            linvel: [0.0; 3],
            restitution: 0.0,
            friction: 0.6,
        }
    }

    fn ball_at(y: f32, restitution: f32, id: &str) -> BodyDesc {
        BodyDesc {
            id: id.into(),
            dynamic: true,
            shape: ShapeDesc::Ball { radius: 0.5 },
            translation: [0.0, y, 0.0],
            linvel: [0.0; 3],
            restitution,
            friction: 0.6,
        }
    }

    fn step_n(world: &mut PhysicsWorld, n: usize) -> Vec<BodyState> {
        let mut last = Vec::new();
        for _ in 0..n {
            last = world.step(1.0 / 60.0);
        }
        last
    }

    fn state_of<'a>(states: &'a [BodyState], id: &str) -> &'a BodyState {
        states.iter().find(|s| s.id == id).unwrap()
    }

    #[test]
    fn ball_settles_on_ground_and_is_grounded() {
        let mut w = PhysicsWorld::new(vec![ground(), ball_at(5.0, 0.0, "b")]);
        let states = step_n(&mut w, 180);
        let s = state_of(&states, "b");
        assert!((s.translation[1] - 0.5).abs() < 0.05, "y = {}", s.translation[1]);
        assert!(s.grounded);
        assert!(s.linvel[1].abs() < 0.05);
    }

    #[test]
    fn restitution_makes_the_ball_rise_again() {
        let mut w = PhysicsWorld::new(vec![ground(), ball_at(5.0, 0.6, "b")]);
        let mut rose_after_impact = false;
        for _ in 0..180 {
            let states = w.step(1.0 / 60.0);
            let s = state_of(&states, "b");
            if s.linvel[1] > 1.0 {
                rose_after_impact = true;
            }
        }
        assert!(rose_after_impact, "bouncy ball never bounced back up");
    }

    #[test]
    fn set_velocity_and_teleport_work() {
        let mut w = PhysicsWorld::new(vec![ground(), ball_at(5.0, 0.0, "b")]);
        step_n(&mut w, 180);
        let handle = *w.handles.get("b").unwrap();
        w.bodies
            .get_mut(handle)
            .unwrap()
            .set_linvel(vector![0.0, 7.0, 0.0], true);
        let states = w.step(1.0 / 60.0);
        assert!(state_of(&states, "b").translation[1] > 0.5, "jump did not lift the ball");

        w.bodies
            .get_mut(handle)
            .unwrap()
            .set_translation(vector![0.0, 10.0, 0.0], true);
        let states = w.step(1.0 / 60.0);
        assert!(state_of(&states, "b").translation[1] > 9.9, "teleport did not move the ball");
    }

    #[test]
    fn dynamic_pairs_push_each_other_without_tunnelling() {
        let mut a = ball_at(0.5, 0.3, "a");
        a.translation = [0.0, 0.5, 0.0];
        a.linvel = [0.0, 0.0, 6.0];
        let mut b = ball_at(0.5, 0.3, "b");
        b.translation = [0.0, 0.5, 3.0];
        let mut w = PhysicsWorld::new(vec![ground(), a, b]);
        let mut last = Vec::new();
        for _ in 0..90 {
            last = w.step(1.0 / 60.0);
        }
        let sa = state_of(&last, "a");
        let sb = state_of(&last, "b");
        assert!(sb.translation[2] > 3.3, "pushed ball did not move: {}", sb.translation[2]);
        let dist = ((sa.translation[0] - sb.translation[0]).powi(2)
            + (sa.translation[1] - sb.translation[1]).powi(2)
            + (sa.translation[2] - sb.translation[2]).powi(2))
        .sqrt();
        assert!(dist >= 0.98, "balls interpenetrate: dist = {dist}");
    }

    #[test]
    fn cuboid_platforms_are_solid() {
        let platform = BodyDesc {
            id: "plat".into(),
            dynamic: false,
            shape: ShapeDesc::Cuboid { hx: 2.0, hy: 0.25, hz: 2.0 },
            translation: [0.0, 0.75, 0.0],
            linvel: [0.0; 3],
            restitution: 0.0,
            friction: 0.6,
        };
        let mut w = PhysicsWorld::new(vec![ground(), platform, ball_at(4.0, 0.0, "b")]);
        let states = step_n(&mut w, 180);
        let y = state_of(&states, "b").translation[1];
        assert!((y - 1.5).abs() < 0.05, "ball did not land on the platform: y = {y}");
    }

    #[test]
    fn fixed_timestep_steps_are_deterministic() {
        let mut a = PhysicsWorld::new(vec![ground(), ball_at(5.0, 0.6, "b")]);
        let mut b = PhysicsWorld::new(vec![ground(), ball_at(5.0, 0.6, "b")]);
        for _ in 0..90 {
            a.step(1.0 / 60.0);
            b.step(1.0 / 60.0);
            let (la, lb) = (a.last_states(), b.last_states());
            let (sa, sb) = (state_of(&la, "b"), state_of(&lb, "b"));
            assert_eq!(sa.translation, sb.translation, "trajectories diverged");
            assert_eq!(sa.linvel, sb.linvel);
        }
    }

    #[test]
    fn loop_flags_control_stop_and_pause_independently() {
        let flags = LoopFlags {
            stop: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
        };
        // Pause does not stop…
        flags.paused.store(true, Ordering::Relaxed);
        assert!(!flags.stop.load(Ordering::Relaxed));
        // …and stop is final.
        flags.stop.store(true, Ordering::Relaxed);
        assert!(flags.stop.load(Ordering::Relaxed));
        assert!(flags.paused.load(Ordering::Relaxed)); // pause state irrelevant after stop
    }
}
