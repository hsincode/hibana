"""Import inside Blender. Does not clear scenes, replace geometry or change render settings."""
import math
import bpy
from mathutils import Vector, Quaternion, Matrix

def aim_camera(camera, position, target, reference_up=(0,1,0), roll=0.):
    """Return the unrolled up vector to carry to the next sample. roll is radians."""
    position,target,up=Vector(position),Vector(target),Vector(reference_up)
    delta=target-position
    if delta.length<1e-9:raise ValueError('Camera position equals target.')
    forward=delta.normalized()
    up=up-forward*up.dot(forward)
    if up.length<1e-7:
        fallback=min((Vector((1,0,0)),Vector((0,1,0)),Vector((0,0,1))),key=lambda axis:abs(axis.dot(forward)))
        up=fallback-forward*fallback.dot(forward)
    up.normalize();right=forward.cross(up).normalized();up=right.cross(forward).normalized()
    base=Matrix((right,up,-forward)).transposed().to_quaternion()
    q=base@Quaternion((0,0,1),roll)
    previous_local=camera.rotation_quaternion.copy()
    world_scale=camera.matrix_world.to_scale()
    camera.rotation_mode='QUATERNION'
    camera.matrix_world=Matrix.LocRotScale(position,q,world_scale)
    if previous_local.dot(camera.rotation_quaternion)<0:camera.rotation_quaternion.negate()
    return up.copy()

def rotate_world(obj, base_quaternion, angle, axis=(0,0,1)):
    """base_quaternion is the initial WORLD orientation; angle is radians. Use a centered pivot."""
    axis=Vector(axis)
    if axis.length<1e-9:raise ValueError('Rotation axis is zero.')
    position,_,scale=obj.matrix_world.decompose()
    obj.rotation_mode='QUATERNION'
    obj.matrix_world=Matrix.LocRotScale(position,Quaternion(axis.normalized(),angle)@Quaternion(base_quaternion),scale)

def make_center_pivot(objects,name='Subject world pivot'):
    """Pass existing assembly root objects. Preserve their world transforms."""
    objects=list(objects)
    if not objects:raise ValueError('No objects to pivot.')
    bpy.context.view_layer.update()
    selected=set(objects)
    for obj in objects:
        parent=obj.parent
        while parent:
            if parent in selected:raise ValueError('Pass assembly roots, not a parent and its descendant.')
            parent=parent.parent
    def family(obj):
        yield obj
        for child in obj.children:yield from family(child)
    geometry=[node for obj in objects for node in family(obj) if node.type in {'MESH','CURVE','SURFACE','META','FONT'}]
    points=[node.matrix_world@Vector(corner) for node in geometry for corner in node.bound_box]
    if not points:raise ValueError('No geometry bounds; choose an explicit pivot for collection instances.')
    lo=Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi=Vector(tuple(max(p[i] for p in points) for i in range(3)))
    pivot=bpy.data.objects.new(name,None);bpy.context.scene.collection.objects.link(pivot);pivot.location=(lo+hi)/2
    bpy.context.view_layer.update()
    for obj in objects:
        world=obj.matrix_world.copy();obj.parent=pivot;obj.matrix_world=world
    return pivot

def quaternion_step_degrees(a,b):
    cosine=min(1.,max(0.,abs(Quaternion(a).normalized().dot(Quaternion(b).normalized()))))
    return math.degrees(2*math.acos(cosine))
